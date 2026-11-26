import type { PingSample, PingStats, TargetPreset } from '../types/network';
import { apiUrl, getApiBaseUrl } from './apiUrl';

export const BROWSER_PRESETS: TargetPreset[] = [
  {
    id: 'self-edge',
    label: 'App Server Edge',
    target: 'Current Server (/api/ping)',
    description: 'Measures real round-trip time from your browser network to this server.',
    browserUrl: '/api/ping',
    isSelf: true,
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare 1.1.1.1',
    target: '1.1.1.1',
    description: 'Anycast global DNS edge from your local connection.',
    browserUrl: 'https://1.1.1.1/cdn-cgi/trace',
    tcpHost: '1.1.1.1',
    defaultPort: 443,
  },
  {
    id: 'google-dns',
    label: 'Google DNS',
    target: 'dns.google',
    description: 'Google Public DNS HTTPS endpoint from your network.',
    browserUrl: 'https://dns.google/resolve?name=example.com&type=A',
    tcpHost: '8.8.8.8',
    defaultPort: 443,
  },
  {
    id: 'github',
    label: 'GitHub',
    target: 'github.com',
    description: 'Global developer platform edge reachability.',
    browserUrl: 'https://github.com/favicon.ico',
    tcpHost: 'github.com',
    defaultPort: 443,
  },
  {
    id: 'local-router',
    label: 'Local Router (192.168.1.1)',
    target: '192.168.1.1',
    description: 'Tests local gateway HTTP reachability (may be blocked by browser HTTPS policies).',
    browserUrl: 'http://192.168.1.1/',
    isLocalLan: true,
  },
];

export const SERVER_TCP_PRESETS: TargetPreset[] = [
  {
    id: 'tcp-cf',
    label: '1.1.1.1:443',
    target: '1.1.1.1',
    description: 'Cloudflare public resolver TCP handshake.',
    tcpHost: '1.1.1.1',
    defaultPort: 443,
  },
  {
    id: 'tcp-google',
    label: '8.8.8.8:443',
    target: '8.8.8.8',
    description: 'Google public DNS TCP handshake.',
    tcpHost: '8.8.8.8',
    defaultPort: 443,
  },
  {
    id: 'tcp-github',
    label: 'github.com:443',
    target: 'github.com',
    description: 'GitHub HTTPS port TCP connect.',
    tcpHost: 'github.com',
    defaultPort: 443,
  },
  {
    id: 'tcp-wikipedia',
    label: 'wikipedia.org:443',
    target: 'wikipedia.org',
    description: 'Wikimedia edge TCP handshake.',
    tcpHost: 'wikipedia.org',
    defaultPort: 443,
  },
];

export function normalizeBrowserProbeUrl(rawTarget: string): {
  ok: true;
  url: string;
  displayTarget: string;
  isSameOrigin: boolean;
} | { ok: false; error: string } {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return { ok: false, error: 'Please enter a domain, IP, or URL.' };
  }

  if (trimmed === '/api/ping' || trimmed.toLowerCase() === 'current server (/api/ping)') {
    return {
      ok: true,
      url: '/api/ping',
      displayTarget: 'Current Server (/api/ping)',
      isSameOrigin: true,
    };
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Only HTTP and HTTPS protocols are supported.' };
      }
      return {
        ok: true,
        url: parsed.toString(),
        displayTarget: parsed.host,
        isSameOrigin: false,
      };
    } catch {
      return { ok: false, error: 'Invalid URL format.' };
    }
  }

  // Detect private/local IPv4 so we default to http:// for LAN testing if entered directly
  const isPrivateV4 =
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.0\.0\.1)/.test(trimmed) ||
    trimmed === 'localhost';
  const scheme = isPrivateV4 ? 'http://' : 'https://';
  try {
    const parsed = new URL(`${scheme}${trimmed}`);
    return {
      ok: true,
      url: parsed.toString(),
      displayTarget: parsed.host,
      isSameOrigin: false,
    };
  } catch {
    return { ok: false, error: 'Invalid domain or IP address.' };
  }
}

export async function measureBrowserPing(
  url: string,
  displayTarget: string,
  seq: number,
  timeoutMs = 3500,
  signal?: AbortSignal
): Promise<PingSample> {
  const isApiRelative = url.startsWith('/');
  const resolvedUrl = isApiRelative ? apiUrl(url) : url;
  const isSameOrigin = isApiRelative && !getApiBaseUrl();
  const cacheBustSep = resolvedUrl.includes('?') ? '&' : '?';
  const probeUrl = `${resolvedUrl}${cacheBustSep}_np=${Date.now()}_${seq}`;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort('timeout'), timeoutMs);

  const onExternalAbort = () => controller.abort('cancelled');
  if (signal) {
    if (signal.aborted) {
      window.clearTimeout(timeoutId);
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const start = performance.now();
  try {
    const res = await fetch(probeUrl, {
      method: 'GET',
      mode: isSameOrigin ? 'same-origin' : isApiRelative ? 'cors' : 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });

    const rttMs = Math.round((performance.now() - start) * 100) / 100;

    if (isSameOrigin && !res.ok) {
      return {
        seq,
        timestamp: Date.now(),
        target: displayTarget,
        rttMs: null,
        status: 'error',
        protocol: 'HTTP/S',
        note: `HTTP ${res.status}`,
      };
    }

    return {
      seq,
      timestamp: Date.now(),
      target: displayTarget,
      rttMs,
      status: 'ok',
      protocol: isSameOrigin ? 'HTTPS (Same-Origin)' : url.startsWith('http://') ? 'HTTP (no-cors)' : 'HTTPS (no-cors)',
    };
  } catch (err) {
    const elapsed = Math.round((performance.now() - start) * 100) / 100;
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (controller.signal.aborted && controller.signal.reason === 'timeout') {
      return {
        seq,
        timestamp: Date.now(),
        target: displayTarget,
        rttMs: null,
        status: 'timeout',
        protocol: url.startsWith('http://') ? 'HTTP' : 'HTTPS',
        note: `Timed out after ${timeoutMs}ms`,
      };
    }
    const message = err instanceof Error ? err.message : 'Network error';
    const likelyBlocked =
      url.startsWith('http://') ||
      /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(displayTarget);

    return {
      seq,
      timestamp: Date.now(),
      target: displayTarget,
      rttMs: null,
      status: likelyBlocked ? 'blocked' : 'error',
      protocol: url.startsWith('http://') ? 'HTTP' : 'HTTPS',
      note: likelyBlocked
        ? `Blocked by browser HTTPS / Private Network policy (${elapsed}ms)`
        : `Unreachable or blocked (${message})`,
    };
  } finally {
    window.clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function measureServerTcpPing(
  host: string,
  port: number,
  seq: number,
  signal?: AbortSignal
): Promise<PingSample> {
  const res = await fetch(apiUrl('/api/probe/tcp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, port }),
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    return {
      seq,
      timestamp: Date.now(),
      target: host,
      port,
      rttMs: null,
      status: 'error',
      protocol: `TCP:${port}`,
      note: data?.error || `HTTP ${res.status}`,
    };
  }

  return {
    seq,
    timestamp: data.timestamp || Date.now(),
    target: data.host || host,
    resolvedIp: data.resolvedIp,
    port: data.port ?? port,
    dnsMs: data.dnsMs,
    rttMs: data.ok ? data.rttMs : null,
    status: data.ok ? 'ok' : data.error?.includes('timeout') ? 'timeout' : 'error',
    protocol: `TCP:${data.port ?? port}`,
    note: data.error,
  };
}

export function computePingStats(samples: PingSample[]): PingStats {
  const sent = samples.length;
  if (sent === 0) {
    return {
      sent: 0,
      received: 0,
      lost: 0,
      lossPct: 0,
      latestMs: null,
      minMs: null,
      maxMs: null,
      avgMs: null,
      medianMs: null,
      p95Ms: null,
      jitterMs: null,
    };
  }

  const valid = samples.filter((s) => s.status === 'ok' && s.rttMs !== null).map((s) => s.rttMs as number);
  const received = valid.length;
  const lost = sent - received;
  const lossPct = Math.round((lost / sent) * 1000) / 10;

  if (received === 0) {
    return {
      sent,
      received: 0,
      lost,
      lossPct,
      latestMs: null,
      minMs: null,
      maxMs: null,
      avgMs: null,
      medianMs: null,
      p95Ms: null,
      jitterMs: null,
    };
  }

  const latestMs = valid[valid.length - 1];
  const sorted = [...valid].sort((a, b) => a - b);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  const sum = valid.reduce((acc, v) => acc + v, 0);
  const avgMs = Math.round((sum / received) * 100) / 100;

  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
      : sorted[mid];

  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95Ms = sorted[p95Idx];

  // RFC 3550-style consecutive absolute difference mean (jitter)
  let jitterMs = 0;
  if (valid.length > 1) {
    let diffSum = 0;
    for (let i = 1; i < valid.length; i++) {
      diffSum += Math.abs(valid[i] - valid[i - 1]);
    }
    jitterMs = Math.round((diffSum / (valid.length - 1)) * 100) / 100;
  }

  return {
    sent,
    received,
    lost,
    lossPct,
    latestMs,
    minMs,
    maxMs,
    avgMs,
    medianMs,
    p95Ms,
    jitterMs,
  };
}

export function formatMs(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) return '—';
  return `${val.toFixed(val >= 100 ? 0 : 1)} ms`;
}

export function exportSamplesCsv(samples: PingSample[], filenamePrefix = 'netpulse-ping'): void {
  const headers = ['seq', 'timestamp_iso', 'target', 'resolved_ip', 'port', 'protocol', 'status', 'rtt_ms', 'dns_ms', 'note'];
  const escapeCell = (v: unknown) => {
    const str = v === null || v === undefined ? '' : String(v);
    return `"${str.replace(/"/g, '""')}"`;
  };

  const rows = samples.map((s) =>
    [
      s.seq,
      new Date(s.timestamp).toISOString(),
      s.target,
      s.resolvedIp ?? '',
      s.port ?? '',
      s.protocol,
      s.status,
      s.rttMs ?? '',
      s.dnsMs ?? '',
      s.note ?? '',
    ]
      .map(escapeCell)
      .join(',')
  );

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
