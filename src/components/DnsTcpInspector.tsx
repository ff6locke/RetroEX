import { useState } from 'react';
import { Globe, Server } from 'lucide-react';
import type { DnsLookupResult, PingSample } from '../types/network';
import { formatMs, measureServerTcpPing } from '../utils/networkProbes';
import { apiUrl } from '../utils/apiUrl';

const QUICK_HOSTS = ['cloudflare.com', 'dns.google', 'github.com', '1.1.1.1', '8.8.8.8'];
const COMMON_PORTS = [443, 80, 53, 22];

export function DnsTcpInspector() {
  const [host, setHost] = useState('cloudflare.com');
  const [port, setPort] = useState<number>(443);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dnsResult, setDnsResult] = useState<DnsLookupResult | null>(null);
  const [tcpSamples, setTcpSamples] = useState<PingSample[]>([]);

  const runInspection = async (targetHost = host, targetPort = port) => {
    const cleanHost = targetHost.trim();
    if (!cleanHost) {
      setError('Please enter a public domain name or IP address.');
      return;
    }
    setLoading(true);
    setError(null);
    setDnsResult(null);
    setTcpSamples([]);

    try {
      const dnsRes = await fetch(apiUrl('/api/probe/dns'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: cleanHost }),
      });
      const dnsData = (await dnsRes.json()) as DnsLookupResult;
      if (!dnsRes.ok || !dnsData.ok) {
        setError(dnsData.error || 'DNS resolution failed.');
        setLoading(false);
        return;
      }
      setDnsResult(dnsData);

      const collected: PingSample[] = [];
      for (let seq = 1; seq <= 4; seq++) {
        const sample = await measureServerTcpPing(dnsData.host, targetPort, seq);
        collected.push(sample);
        setTcpSamples([...collected]);
        if (seq < 4) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Server probe failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runInspection(host, port);
  };

  const okSamples = tcpSamples.filter((s) => s.status === 'ok' && s.rttMs !== null);
  const avgTcp =
    okSamples.length > 0
      ? okSamples.reduce((sum, s) => sum + (s.rttMs ?? 0), 0) / okSamples.length
      : null;

  return (
    <section className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="pb-5 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            Server-Side DNS &amp; TCP Handshake Inspector
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Resolves public DNS records and measures 4 consecutive TCP socket connect handshakes
            from the cloud server. Private, loopback, and internal network addresses are blocked.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-7">
            <label htmlFor="dns-tcp-host" className="block text-xs font-medium text-slate-600 mb-1.5">
              Public Hostname or IP
            </label>
            <input
              id="dns-tcp-host"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="e.g. cloudflare.com or 1.1.1.1"
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div className="md:col-span-2">
            <label htmlFor="dns-tcp-port" className="block text-xs font-medium text-slate-600 mb-1.5">
              TCP Port
            </label>
            <input
              id="dns-tcp-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Math.max(1, Math.min(65535, Number(e.target.value) || 443)))}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 px-4 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {loading ? 'Inspecting...' : 'Run DNS & TCP Probe'}
            </button>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
          <span>Quick hosts:</span>
          {QUICK_HOSTS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => {
                setHost(q);
                void runInspection(q, port);
              }}
              className="font-mono text-slate-700 hover:text-blue-600 underline underline-offset-4 decoration-slate-300"
            >
              {q}
            </button>
          ))}
          <span aria-hidden="true" className="text-slate-300">|</span>
          <span>Ports:</span>
          {COMMON_PORTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPort(p)}
              className={`font-mono tabular-nums px-2 py-0.5 rounded border transition-colors ${
                port === p
                  ? 'border-blue-600 text-blue-700 bg-blue-50'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-5 p-3.5 border border-red-200 bg-red-50/70 rounded-md text-sm text-red-800">
            {error}
          </div>
        )}

        {!dnsResult && !loading && !error && (
          <div className="mt-6 py-10 border border-dashed border-slate-200 rounded-lg text-center">
            <p className="text-sm font-medium text-slate-700">Ready to inspect DNS and TCP path</p>
            <p className="mt-1 text-xs text-slate-500">
              Select a host above or enter any public domain to inspect DNS records and TCP handshake timing.
            </p>
          </div>
        )}

        {(dnsResult || loading) && (
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="border border-slate-200 rounded-lg p-5">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Globe className="w-4 h-4 text-slate-500" />
                  DNS Resolution
                </div>
                {dnsResult?.resolveMs !== undefined && (
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    Lookup: {formatMs(dnsResult.resolveMs)}
                  </span>
                )}
              </div>

              {dnsResult ? (
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Canonical Host</dt>
                    <dd className="font-mono text-slate-900">{dnsResult.host}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500 shrink-0">IPv4 (A)</dt>
                    <dd className="font-mono tabular-nums text-right text-slate-900">
                      {dnsResult.ipv4?.length ? dnsResult.ipv4.join(', ') : 'None'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500 shrink-0">IPv6 (AAAA)</dt>
                    <dd className="font-mono tabular-nums text-right text-slate-900 break-all">
                      {dnsResult.ipv6?.length ? dnsResult.ipv6.join(', ') : 'None'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500 shrink-0">CNAME</dt>
                    <dd className="font-mono text-right text-slate-900">
                      {dnsResult.cname?.length ? dnsResult.cname.join(', ') : 'None'}
                    </dd>
                  </div>
                </dl>
              ) : (
                <div className="mt-4 space-y-2.5 animate-pulse">
                  <div className="h-4 bg-slate-100 rounded w-3/4" />
                  <div className="h-4 bg-slate-100 rounded w-1/2" />
                  <div className="h-4 bg-slate-100 rounded w-2/3" />
                </div>
              )}
            </div>

            <div className="border border-slate-200 rounded-lg p-5">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Server className="w-4 h-4 text-slate-500" />
                  TCP Connect Timing (Port {port})
                </div>
                {avgTcp !== null && (
                  <span className="text-xs font-mono tabular-nums font-medium text-emerald-700">
                    Avg: {formatMs(avgTcp)}
                  </span>
                )}
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-xs text-slate-500">
                      <th className="py-1.5 pr-3">Seq</th>
                      <th className="py-1.5 px-3">Resolved IP</th>
                      <th className="py-1.5 px-3">Status</th>
                      <th className="py-1.5 pl-3 text-right">Connect RTT</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono tabular-nums text-xs">
                    {tcpSamples.map((s) => (
                      <tr key={s.seq}>
                        <td className="py-2 pr-3 text-slate-600">#{s.seq}</td>
                        <td className="py-2 px-3 text-slate-800">{s.resolvedIp || '—'}</td>
                        <td className="py-2 px-3">
                          {s.status === 'ok' ? (
                            <span className="text-emerald-700 font-medium">Open</span>
                          ) : (
                            <span className="text-red-700 font-medium">{s.note || s.status}</span>
                          )}
                        </td>
                        <td className="py-2 pl-3 text-right font-medium text-slate-900">
                          {formatMs(s.rttMs)}
                        </td>
                      </tr>
                    ))}
                    {loading && tcpSamples.length < 4 && (
                      <tr>
                        <td colSpan={4} className="py-2 text-slate-400">
                          Measuring handshake {tcpSamples.length + 1} of 4...
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
