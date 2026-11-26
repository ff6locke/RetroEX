import { useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Play, Search, Trash2 } from 'lucide-react';
import { formatMs, measureBrowserPing } from '../utils/networkProbes';

interface GatewayProbeRow {
  ip: string;
  label: string;
  scheme: 'https' | 'http';
  status: 'idle' | 'probing' | 'reachable' | 'blocked' | 'timeout';
  rttMs: number | null;
  note?: string;
}

interface ParsedLanDevice {
  id: string;
  ip: string;
  hostname: string;
  mac: string;
  macType: 'Hardware OUI' | 'Randomized / Local' | 'Broadcast' | 'Multicast' | 'Incomplete';
  roleHint: string;
  ifaceOrState: string;
}

type OsCommandPlatform = 'macos-linux' | 'windows' | 'nmap';

const DEFAULT_GATEWAYS: GatewayProbeRow[] = [
  { ip: '192.168.1.1', label: 'Standard Router (192.168.1.1)', scheme: 'https', status: 'idle', rttMs: null },
  { ip: '192.168.0.1', label: 'Common Router (192.168.0.1)', scheme: 'https', status: 'idle', rttMs: null },
  { ip: '192.168.1.254', label: 'ISP Gateway (192.168.1.254)', scheme: 'https', status: 'idle', rttMs: null },
  { ip: '192.168.50.1', label: 'ASUS / Mesh Router (192.168.50.1)', scheme: 'https', status: 'idle', rttMs: null },
  { ip: '10.0.0.1', label: 'Xfinity / Enterprise LAN (10.0.0.1)', scheme: 'https', status: 'idle', rttMs: null },
  { ip: '192.168.1.1', label: 'Router HTTP (192.168.1.1)', scheme: 'http', status: 'idle', rttMs: null },
];

const IPV4_REGEX = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b/;
const MAC_REGEX = /\b([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})\b/;

function normalizeMac(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/-/g, ':')
    .split(':')
    .map((part) => (part.length === 1 ? `0${part}` : part))
    .join(':');
}

function classifyMac(mac: string, ip: string): ParsedLanDevice['macType'] {
  if (!mac || mac === '(incomplete)' || mac === '00:00:00:00:00:00') {
    return 'Incomplete';
  }
  if (mac === 'ff:ff:ff:ff:ff:ff' || ip.endsWith('.255')) {
    return 'Broadcast';
  }
  const firstOctet = Number.parseInt(mac.slice(0, 2), 16);
  if (Number.isNaN(firstOctet)) return 'Incomplete';
  if ((firstOctet & 0x01) === 1 || ip.startsWith('224.') || ip.startsWith('239.')) {
    return 'Multicast';
  }
  if ((firstOctet & 0x02) === 0x02) {
    return 'Randomized / Local';
  }
  return 'Hardware OUI';
}

function inferRoleHint(ip: string, macType: ParsedLanDevice['macType'], hostname: string): string {
  if (macType === 'Broadcast') return 'Subnet Broadcast';
  if (macType === 'Multicast') return 'Multicast Group';
  if (macType === 'Incomplete') return 'Unresolved / Offline';
  const lastOctet = Number(ip.split('.')[3]);
  if (lastOctet === 1 || lastOctet === 254 || hostname.toLowerCase().includes('router') || hostname.toLowerCase().includes('gateway')) {
    return 'Gateway / Router Candidate';
  }
  return 'LAN Host';
}

function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return 0;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function parseLanDiscoveryOutput(rawText: string): ParsedLanDevice[] {
  const lines = rawText.split(/\r?\n/);
  const devicesByIp = new Map<string, ParsedLanDevice>();
  let pendingNmapIp: string | null = null;
  let pendingNmapHost = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle nmap multi-line format:
    // "Nmap scan report for router.lan (192.168.1.1)"
    // "MAC Address: AA:BB:CC:DD:EE:FF (Vendor Name)"
    if (line.startsWith('Nmap scan report for ')) {
      const ipMatch = line.match(IPV4_REGEX);
      if (ipMatch) {
        pendingNmapIp = ipMatch[1];
        const beforeIp = line.replace('Nmap scan report for ', '').split('(')[0].trim();
        pendingNmapHost = beforeIp && beforeIp !== pendingNmapIp ? beforeIp : '';
        const existing = devicesByIp.get(pendingNmapIp);
        if (!existing) {
          devicesByIp.set(pendingNmapIp, {
            id: pendingNmapIp,
            ip: pendingNmapIp,
            hostname: pendingNmapHost || '—',
            mac: '—',
            macType: 'Incomplete',
            roleHint: inferRoleHint(pendingNmapIp, 'Incomplete', pendingNmapHost),
            ifaceOrState: 'Host Up (nmap)',
          });
        }
      }
      continue;
    }

    if (line.startsWith('MAC Address:') && pendingNmapIp) {
      const macMatch = line.match(MAC_REGEX);
      if (macMatch) {
        const mac = normalizeMac(macMatch[1]);
        const vendorMatch = line.match(/\(([^)]+)\)/);
        const macType = classifyMac(mac, pendingNmapIp);
        devicesByIp.set(pendingNmapIp, {
          id: pendingNmapIp,
          ip: pendingNmapIp,
          hostname: pendingNmapHost || '—',
          mac,
          macType,
          roleHint: inferRoleHint(pendingNmapIp, macType, pendingNmapHost),
          ifaceOrState: vendorMatch ? vendorMatch[1] : 'nmap',
        });
      }
      pendingNmapIp = null;
      pendingNmapHost = '';
      continue;
    }

    const ipMatch = line.match(IPV4_REGEX);
    if (!ipMatch) continue;
    const ip = ipMatch[1];

    // Skip subnet headers like "Interface: 192.168.1.24 --- 0x4"
    if (line.toLowerCase().startsWith('interface:')) continue;

    const macMatch = line.match(MAC_REGEX);
    const isIncomplete = line.toLowerCase().includes('(incomplete)') || line.toLowerCase().includes('incomplete');
    const mac = macMatch ? normalizeMac(macMatch[1]) : isIncomplete ? '(incomplete)' : '—';
    const macType = classifyMac(mac, ip);

    // Extract hostname in macOS/BSD arp -a: "myhost.local (192.168.1.15) at ..."
    let hostname = '—';
    const parenIpIdx = line.indexOf(`(${ip})`);
    if (parenIpIdx > 0) {
      const prefix = line.slice(0, parenIpIdx).trim();
      if (prefix && prefix !== '?') {
        hostname = prefix;
      }
    }

    // Extract interface or ARP state
    let ifaceOrState = '—';
    const onIface = line.match(/\bon\s+([a-zA-Z0-9._-]+)\b/);
    const devIface = line.match(/\bdev\s+([a-zA-Z0-9._-]+)\b/);
    const stateMatch = line.match(/\b(REACHABLE|STALE|DELAY|PROBE|PERMANENT|FAILED|dynamic|static)\b/i);
    if (onIface && stateMatch) {
      ifaceOrState = `${onIface[1]} · ${stateMatch[1]}`;
    } else if (devIface && stateMatch) {
      ifaceOrState = `${devIface[1]} · ${stateMatch[1]}`;
    } else if (onIface) {
      ifaceOrState = onIface[1];
    } else if (stateMatch) {
      ifaceOrState = stateMatch[1];
    }

    devicesByIp.set(ip, {
      id: `${ip}-${i}`,
      ip,
      hostname,
      mac,
      macType,
      roleHint: inferRoleHint(ip, macType, hostname),
      ifaceOrState,
    });
  }

  return Array.from(devicesByIp.values()).sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));
}

function isLocalPrivateIpOrLocalHost(input: string): boolean {
  const clean = input.trim().toLowerCase();
  if (clean.endsWith('.local')) return true;
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.0\.0\.1)/.test(clean)) {
    return IPV4_REGEX.test(clean);
  }
  return false;
}

export function LanDevicesInspector() {
  const [gateways, setGateways] = useState<GatewayProbeRow[]>(DEFAULT_GATEWAYS);
  const [probingGateways, setProbingGateways] = useState(false);
  const [customLanIp, setCustomLanIp] = useState('');
  const [customScheme, setCustomScheme] = useState<'https' | 'http'>('https');
  const [customIpError, setCustomIpError] = useState<string | null>(null);

  const [osTab, setOsTab] = useState<OsCommandPlatform>('macos-linux');
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [copiedCmd, setCopiedCmd] = useState(false);

  const [rawPaste, setRawPaste] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [hideMulticastBroadcast, setHideMulticastBroadcast] = useState(true);

  const [routerIpInput, setRouterIpInput] = useState('192.168.1.1');
  const [wanStatus, setWanStatus] = useState<'unknown' | 'public' | 'cgnat-double-nat' | 'disconnected'>('unknown');
  const [routerDns, setRouterDns] = useState<'unknown' | 'isp' | 'custom-fast'>('unknown');
  const [wifiBand, setWifiBand] = useState<'unknown' | '5ghz-6ghz' | '24ghz-only' | 'smart-connect'>('unknown');
  const [remoteAdmin, setRemoteAdmin] = useState<'unknown' | 'disabled' | 'enabled'>('unknown');
  const [upnpState, setUpnpState] = useState<'unknown' | 'disabled' | 'enabled'>('unknown');

  const probeGatewayRow = async (idx: number, row: GatewayProbeRow) => {
    setGateways((prev) =>
      prev.map((g, i) => (i === idx ? { ...g, status: 'probing', note: undefined } : g))
    );
    const url = `${row.scheme}://${row.ip}/`;
    const sample = await measureBrowserPing(url, row.ip, 1, 2200);
    setGateways((prev) =>
      prev.map((g, i) =>
        i === idx
          ? {
              ...g,
              status:
                sample.status === 'ok'
                  ? 'reachable'
                  : sample.status === 'blocked'
                    ? 'blocked'
                    : 'timeout',
              rttMs: sample.rttMs,
              note: sample.note,
            }
          : g
      )
    );
  };

  const handleProbeAllGateways = async () => {
    if (probingGateways) return;
    setProbingGateways(true);
    await Promise.all(gateways.map((row, idx) => probeGatewayRow(idx, row)));
    setProbingGateways(false);
  };

  const handleAddCustomLanProbe = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customLanIp.trim().toLowerCase();
    if (!isLocalPrivateIpOrLocalHost(trimmed)) {
      setCustomIpError('Enter a local private IPv4 (192.168.x.x, 10.x.x.x, 172.16-31.x.x) or .local host.');
      return;
    }
    setCustomIpError(null);
    const newRow: GatewayProbeRow = {
      ip: trimmed,
      label: `Custom LAN (${trimmed})`,
      scheme: customScheme,
      status: 'idle',
      rttMs: null,
    };
    const nextIdx = gateways.length;
    setGateways((prev) => [...prev, newRow]);
    setCustomLanIp('');
    void probeGatewayRow(nextIdx, newRow);
  };

  const scanCommand = useMemo(() => {
    const cleanSubnet = subnet.trim() || '192.168.1.0/24';
    const basePrefix = cleanSubnet.split('.').slice(0, 3).join('.') || '192.168.1';
    if (osTab === 'macos-linux') {
      return `for i in $(seq 1 254); do (ping -c 1 -W 1 ${basePrefix}.$i >/dev/null 2>&1 &); done; wait; arp -a`;
    }
    if (osTab === 'windows') {
      return `1..254 | ForEach-Object { Start-Process -NoNewWindow -FilePath ping -ArgumentList "-n 1 -w 200 ${basePrefix}.$_" }; Start-Sleep -Seconds 2; arp -a`;
    }
    return `nmap -sn ${cleanSubnet}`;
  }, [osTab, subnet]);

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(scanCommand);
      setCopiedCmd(true);
      window.setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      // Clipboard may be blocked in restricted contexts
    }
  };

  const parsedDevices = useMemo(() => parseLanDiscoveryOutput(rawPaste), [rawPaste]);

  const filteredDevices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return parsedDevices.filter((d) => {
      if (hideMulticastBroadcast && (d.macType === 'Broadcast' || d.macType === 'Multicast')) {
        return false;
      }
      if (!q) return true;
      return (
        d.ip.toLowerCase().includes(q) ||
        d.hostname.toLowerCase().includes(q) ||
        d.mac.toLowerCase().includes(q) ||
        d.roleHint.toLowerCase().includes(q) ||
        d.ifaceOrState.toLowerCase().includes(q)
      );
    });
  }, [parsedDevices, hideMulticastBroadcast, searchQuery]);

  const deviceSummary = useMemo(() => {
    const unicast = parsedDevices.filter(
      (d) => d.macType === 'Hardware OUI' || d.macType === 'Randomized / Local'
    ).length;
    const randomized = parsedDevices.filter((d) => d.macType === 'Randomized / Local').length;
    const incomplete = parsedDevices.filter((d) => d.macType === 'Incomplete').length;
    return { total: parsedDevices.length, unicast, randomized, incomplete };
  }, [parsedDevices]);

  const exportLanCsv = () => {
    const headers = ['ip', 'hostname', 'mac', 'mac_type', 'role_hint', 'interface_or_state'];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = filteredDevices.map((d) =>
      [d.ip, d.hostname, d.mac, d.macType, d.roleHint, d.ifaceOrState].map(esc).join(',')
    );
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netpulse-lan-devices-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Honest Browser Boundary Notice */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="pb-4 border-b border-slate-200">
          <h1 className="text-xl font-semibold text-slate-900">
            Home Network &amp; LAN Device Inspector
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 max-w-4xl">
            Web browsers cannot scan your home Wi-Fi for MAC addresses or connected devices directly
            because browser sandboxes block ARP, mDNS, and raw ICMP, and HTTPS pages restrict
            unencrypted <span className="font-mono text-slate-800">http://192.168.x.x</span>{' '}
            requests. Below are two real ways to check your home network: probing local HTTPS
            gateways from your browser, and analyzing a local ARP/nmap scan from your computer.
          </p>
        </div>

        {/* Part 1: Browser Local Gateway & Device Probe */}
        <div className="mt-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              1. Browser Local Gateway &amp; Router Reachability
            </h2>
            <p className="text-xs text-slate-500">
              Tests direct browser reachability to common home router and NAS addresses.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleProbeAllGateways()}
            disabled={probingGateways}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            <Play className="w-4 h-4" />
            {probingGateways ? 'Testing Gateways...' : 'Probe Common Gateways'}
          </button>
        </div>

        <form onSubmit={handleAddCustomLanProbe} className="mt-4 flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label htmlFor="custom-lan-ip" className="sr-only">
              Custom local IP or .local host
            </label>
            <input
              id="custom-lan-ip"
              type="text"
              value={customLanIp}
              onChange={(e) => setCustomLanIp(e.target.value)}
              placeholder="Test specific LAN device (e.g. 192.168.1.100, nas.local)"
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
            {customIpError && <p className="mt-1.5 text-xs text-red-600">{customIpError}</p>}
          </div>
          <select
            aria-label="Protocol scheme"
            value={customScheme}
            onChange={(e) => setCustomScheme(e.target.value === 'http' ? 'http' : 'https')}
            className="h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 font-mono"
          >
            <option value="https">https://</option>
            <option value="http">http://</option>
          </select>
          <button
            type="submit"
            className="h-10 px-4 text-sm font-medium text-slate-800 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200/70 transition-colors whitespace-nowrap shrink-0"
          >
            Probe LAN IP
          </button>
        </form>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                <th className="py-2 pr-4">Target</th>
                <th className="py-2 px-3">Protocol</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3 text-right">RTT</th>
                <th className="py-2 pl-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {gateways.map((row, idx) => (
                <tr key={`${row.scheme}-${row.ip}-${idx}`} className="hover:bg-slate-50/70">
                  <td className="py-2.5 pr-4">
                    <div className="font-medium text-slate-900">{row.label}</div>
                    {row.note && <div className="text-xs text-slate-500">{row.note}</div>}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-xs text-slate-600 uppercase">
                    {row.scheme}
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap text-xs font-medium">
                    {row.status === 'idle' ? (
                      <span className="text-slate-400 font-normal">Ready</span>
                    ) : row.status === 'probing' ? (
                      <span className="text-blue-700">Probing</span>
                    ) : row.status === 'reachable' ? (
                      <span className="text-emerald-700">Reachable</span>
                    ) : row.status === 'blocked' ? (
                      <span className="text-amber-700">Blocked by Browser Policy</span>
                    ) : (
                      <span className="text-slate-600">No Response / Timeout</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900">
                    {formatMs(row.rttMs)}
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    <button
                      type="button"
                      onClick={() => void probeGatewayRow(idx, row)}
                      disabled={row.status === 'probing'}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
                    >
                      Test
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Part 2: Real Local ARP / Nmap Device Discovery Parser */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="pb-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            2. Local Home Device Table Analyzer (arp -a / nmap)
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Run this read-only discovery command on your computer to enumerate active devices on
            your router&apos;s subnet, then paste the terminal output below. Parsing stays 100% in
            your browser.
          </p>
        </div>

        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div
            className="inline-flex items-center p-1 bg-slate-100 rounded-lg self-start"
            role="tablist"
            aria-label="Operating system command format"
          >
            {(
              [
                { id: 'macos-linux', label: 'macOS / Linux' },
                { id: 'windows', label: 'Windows PowerShell' },
                { id: 'nmap', label: 'nmap' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={osTab === tab.id}
                onClick={() => setOsTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  osTab === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="lan-subnet-select" className="text-xs font-medium text-slate-600 whitespace-nowrap">
              Home Subnet:
            </label>
            <input
              id="lan-subnet-select"
              type="text"
              value={subnet}
              onChange={(e) => setSubnet(e.target.value)}
              className="h-9 w-40 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-md">
          <code className="text-xs font-mono text-slate-800 break-all">{scanCommand}</code>
          <button
            type="button"
            onClick={() => void handleCopyCommand()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedCmd ? 'Copied' : 'Copy Command'}
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="arp-paste-input" className="text-xs font-medium text-slate-600">
              Paste output from <span className="font-mono">arp -a</span>,{' '}
              <span className="font-mono">ip neigh</span>, or{' '}
              <span className="font-mono">nmap -sn</span>
            </label>
            {rawPaste && (
              <button
                type="button"
                onClick={() => setRawPaste('')}
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
          <textarea
            id="arp-paste-input"
            rows={5}
            value={rawPaste}
            onChange={(e) => setRawPaste(e.target.value)}
            placeholder="Paste your terminal output here (e.g. '? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]')..."
            className="w-full p-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
          />
        </div>

        {parsedDevices.length > 0 && (
          <div className="space-y-4 pt-2">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 font-mono tabular-nums">
                <span className="font-semibold text-slate-900">
                  {deviceSummary.unicast} active unicast devices
                </span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span>{deviceSummary.randomized} randomized/private MACs</span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span>{deviceSummary.incomplete} incomplete</span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter IP, MAC, host..."
                    className="h-8 pl-8 pr-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>
                <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={hideMulticastBroadcast}
                    onChange={(e) => setHideMulticastBroadcast(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                  />
                  Hide multicast/broadcast
                </label>
                <button
                  type="button"
                  onClick={exportLanCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export CSV
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                    <th className="py-2 pr-4">IPv4 Address</th>
                    <th className="py-2 px-3">Hostname</th>
                    <th className="py-2 px-3">MAC Address</th>
                    <th className="py-2 px-3">MAC Classification</th>
                    <th className="py-2 px-3">Role Hint</th>
                    <th className="py-2 pl-3 text-right">Interface / Info</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs font-mono tabular-nums">
                  {filteredDevices.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 pr-4 font-semibold text-slate-900 whitespace-nowrap">
                        {d.ip}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700">{d.hostname}</td>
                      <td className="py-2.5 px-3 text-slate-800 whitespace-nowrap">{d.mac}</td>
                      <td className="py-2.5 px-3 font-sans whitespace-nowrap">
                        <span
                          className={
                            d.macType === 'Randomized / Local'
                              ? 'text-blue-700 font-medium'
                              : d.macType === 'Hardware OUI'
                                ? 'text-emerald-700 font-medium'
                                : 'text-slate-500'
                          }
                        >
                          {d.macType}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-sans text-slate-700 whitespace-nowrap">
                        {d.roleHint}
                      </td>
                      <td className="py-2.5 pl-3 text-right text-slate-600 whitespace-nowrap">
                        {d.ifaceOrState}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Part 3: Router Admin Launcher & Non-Sensitive Settings Audit */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="pb-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            3. Router Admin Page &amp; Settings Check
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            For your security, NetPulse cannot log into your router or view your local admin
            session—and you should never share your router password. Open your router page in a
            new browser tab below, then select the settings you see to get tailored guidance.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 max-w-xs">
            <label htmlFor="router-admin-ip" className="block text-xs font-medium text-slate-600 mb-1.5">
              Your Router Gateway IP
            </label>
            <input
              id="router-admin-ip"
              type="text"
              value={routerIpInput}
              onChange={(e) => setRouterIpInput(e.target.value)}
              placeholder="192.168.1.1"
              className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          {isLocalPrivateIpOrLocalHost(routerIpInput) ? (
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`http://${routerIpInput.trim()}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 h-10 px-4 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                Open http://{routerIpInput.trim()}
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <a
                href={`https://${routerIpInput.trim()}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 h-10 px-4 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                Open https://{routerIpInput.trim()}
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          ) : (
            <p className="text-xs text-red-600">
              Enter a valid private router IP (e.g. 192.168.1.1, 192.168.0.1, or 10.0.0.1).
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>Common gateways:</span>
          {['192.168.1.1', '192.168.0.1', '192.168.1.254', '192.168.50.1', '10.0.0.1'].map((gw) => (
            <button
              key={gw}
              type="button"
              onClick={() => setRouterIpInput(gw)}
              className={`font-mono px-2 py-0.5 rounded border transition-colors ${
                routerIpInput.trim() === gw
                  ? 'border-blue-600 bg-blue-50 text-blue-700 font-medium'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {gw}
            </button>
          ))}
        </div>

        {/* Non-sensitive Settings Audit */}
        <div className="pt-2 border-t border-slate-200 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label htmlFor="audit-wan" className="block text-xs font-medium text-slate-600 mb-1.5">
              WAN / Internet IP Status
            </label>
            <select
              id="audit-wan"
              value={wanStatus}
              onChange={(e) => setWanStatus(e.target.value as typeof wanStatus)}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900"
            >
              <option value="unknown">Not checked yet</option>
              <option value="public">Public IPv4 assigned</option>
              <option value="cgnat-double-nat">Private WAN IP (192.168.x / 10.x / 100.64.x)</option>
              <option value="disconnected">Disconnected / No WAN link</option>
            </select>
          </div>

          <div>
            <label htmlFor="audit-dns" className="block text-xs font-medium text-slate-600 mb-1.5">
              Router DNS Servers
            </label>
            <select
              id="audit-dns"
              value={routerDns}
              onChange={(e) => setRouterDns(e.target.value as typeof routerDns)}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900"
            >
              <option value="unknown">Not checked yet</option>
              <option value="isp">Default ISP DNS (Auto)</option>
              <option value="custom-fast">Custom (1.1.1.1 / 8.8.8.8 / 9.9.9.9)</option>
            </select>
          </div>

          <div>
            <label htmlFor="audit-wifi" className="block text-xs font-medium text-slate-600 mb-1.5">
              Wi-Fi Radio Band
            </label>
            <select
              id="audit-wifi"
              value={wifiBand}
              onChange={(e) => setWifiBand(e.target.value as typeof wifiBand)}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900"
            >
              <option value="unknown">Not checked yet</option>
              <option value="5ghz-6ghz">5 GHz / 6 GHz enabled</option>
              <option value="smart-connect">Single merged SSID (Band Steering)</option>
              <option value="24ghz-only">2.4 GHz only</option>
            </select>
          </div>

          <div>
            <label htmlFor="audit-remote" className="block text-xs font-medium text-slate-600 mb-1.5">
              Remote WAN Administration
            </label>
            <select
              id="audit-remote"
              value={remoteAdmin}
              onChange={(e) => setRemoteAdmin(e.target.value as typeof remoteAdmin)}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900"
            >
              <option value="unknown">Not checked yet</option>
              <option value="disabled">Disabled (Recommended)</option>
              <option value="enabled">Enabled from Internet</option>
            </select>
          </div>

          <div>
            <label htmlFor="audit-upnp" className="block text-xs font-medium text-slate-600 mb-1.5">
              UPnP / Port Forwarding
            </label>
            <select
              id="audit-upnp"
              value={upnpState}
              onChange={(e) => setUpnpState(e.target.value as typeof upnpState)}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900"
            >
              <option value="unknown">Not checked yet</option>
              <option value="disabled">Disabled / Minimal manual rules</option>
              <option value="enabled">UPnP Enabled</option>
            </select>
          </div>
        </div>

        {(wanStatus !== 'unknown' ||
          routerDns !== 'unknown' ||
          wifiBand !== 'unknown' ||
          remoteAdmin !== 'unknown' ||
          upnpState !== 'unknown') && (
          <div className="border-t border-slate-200 pt-4 space-y-2.5 text-sm">
            <h3 className="text-xs font-semibold text-slate-700">Settings Review</h3>
            {wanStatus === 'disconnected' && (
              <p className="text-red-700">
                WAN Disconnected: Check the Ethernet cable between your modem/ONT and the router&apos;s WAN port, and power-cycle the modem for 30 seconds.
              </p>
            )}
            {wanStatus === 'cgnat-double-nat' && (
              <p className="text-amber-700">
                Private WAN IP detected: If your ISP modem is also acting as a router (Double NAT), switch the ISP gateway to Bridge / Passthrough mode or your router to Access Point mode.
              </p>
            )}
            {routerDns === 'isp' && (
              <p className="text-slate-700">
                ISP DNS (Auto): If websites stall before loading, setting primary/secondary DNS to 1.1.1.1 and 8.8.8.8 often reduces lookup latency.
              </p>
            )}
            {wifiBand === '24ghz-only' && (
              <p className="text-amber-700">
                2.4 GHz Only: 2.4 GHz suffers heavy interference and higher jitter. Enable 5 GHz (channels 36–48 or 149–161) for faster, steadier speeds nearby.
              </p>
            )}
            {remoteAdmin === 'enabled' && (
              <p className="text-red-700">
                Security Warning: Disable Remote / WAN Management so your router login page is not exposed to the public internet.
              </p>
            )}
            {upnpState === 'enabled' && (
              <p className="text-amber-700">
                Security Note: Disable UPnP unless required by a specific game console so LAN devices cannot silently open router ports.
              </p>
            )}
            {wanStatus === 'public' &&
              routerDns === 'custom-fast' &&
              wifiBand === '5ghz-6ghz' &&
              remoteAdmin === 'disabled' &&
              upnpState === 'disabled' && (
                <p className="text-emerald-700 font-medium">
                  All checked router settings follow recommended performance and security practices.
                </p>
              )}
          </div>
        )}
      </section>
    </div>
  );
}
