import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Search, XCircle } from 'lucide-react';
import type { ClientNetworkContext, DnsLookupResult, PingSample } from '../types/network';
import {
  computePingStats,
  formatMs,
  measureBrowserPing,
  measureServerTcpPing,
  normalizeBrowserProbeUrl,
} from '../utils/networkProbes';
import { apiUrl, getApiBaseUrl, isAiStudioAuthGatedUrl, isNativeCapacitorOrigin } from '../utils/apiUrl';

type CheckStatus = 'pending' | 'running' | 'pass' | 'warn' | 'fail';

interface DiagnosticStage {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  metric: string;
  detail: string;
}

interface DiagnosticFinding {
  severity: 'ok' | 'warn' | 'fail';
  title: string;
  explanation: string;
  recommendation: string;
}

interface SiteComparisonResult {
  domain: string;
  browserSample: PingSample;
  dnsResult: DnsLookupResult;
  serverTcpSample: PingSample | null;
  verdict: string;
  verdictSeverity: 'ok' | 'warn' | 'fail';
}

interface NetworkDiagnosticsProps {
  networkCtx: ClientNetworkContext;
  onOpenLivePing: (target: string) => void;
}

const INITIAL_STAGES: DiagnosticStage[] = [
  {
    id: 'adapter',
    title: '01. Browser Link & IP Detection',
    status: 'pending',
    summary: 'Waiting to inspect browser network interface...',
    metric: '—',
    detail: 'Checks browser online status, connection API, and observed public IP.',
  },
  {
    id: 'edge-burst',
    title: '02. Edge Latency & Packet Loss (6-Probe Burst)',
    status: 'pending',
    summary: 'Waiting to run 6-probe burst to server edge...',
    metric: '—',
    detail: 'Measures real round-trip latency, consecutive jitter, and packet loss.',
  },
  {
    id: 'dns-reachability',
    title: '03. IP vs Domain Reachability (DNS Isolation)',
    status: 'pending',
    summary: 'Waiting to compare raw IP (1.1.1.1) against domain names...',
    metric: '—',
    detail: 'Distinguishes local DNS resolver failures from broader internet outages.',
  },
  {
    id: 'stability',
    title: '04. Latency Stability & Spike Ratio',
    status: 'pending',
    summary: 'Waiting for burst distribution analysis...',
    metric: '—',
    detail: 'Compares median vs peak latency to spot Wi-Fi interference or congestion.',
  },
];

function StatusLabel({ status }: { status: CheckStatus }) {
  if (status === 'pass') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Nominal
      </span>
    );
  }
  if (status === 'warn') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
        <AlertTriangle className="w-3.5 h-3.5" />
        Degraded
      </span>
    );
  }
  if (status === 'fail') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700">
        <XCircle className="w-3.5 h-3.5" />
        Issue
      </span>
    );
  }
  if (status === 'running') {
    return <span className="text-xs font-medium text-blue-700">Testing...</span>;
  }
  return <span className="text-xs text-slate-400">Queued</span>;
}

export function NetworkDiagnostics({ networkCtx, onOpenLivePing }: NetworkDiagnosticsProps) {
  const [stages, setStages] = useState<DiagnosticStage[]>(INITIAL_STAGES);
  const [findings, setFindings] = useState<DiagnosticFinding[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);

  const [siteInput, setSiteInput] = useState('');
  const [siteError, setSiteError] = useState<string | null>(null);
  const [siteLoading, setSiteLoading] = useState(false);
  const [siteComparison, setSiteComparison] = useState<SiteComparisonResult | null>(null);

  const hasAutoRunRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const updateStage = (id: string, patch: Partial<DiagnosticStage>) => {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const runDiagnostics = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsRunning(true);
    setFindings([]);
    setStages(INITIAL_STAGES);

    const nextFindings: DiagnosticFinding[] = [];

    try {
      // Stage 1: Browser Link & IP Detection
      updateStage('adapter', { status: 'running', summary: 'Checking network adapter and observed IP...' });
      const online = navigator.onLine;
      let observedIp = networkCtx.observedIp;
      try {
        const res = await fetch(apiUrl('/api/network-info'), { cache: 'no-store', signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (typeof data.observedIp === 'string') observedIp = data.observedIp;
        }
      } catch {
        // Handled below via online/edge checks
      }

      if (!online) {
        updateStage('adapter', {
          status: 'fail',
          summary: 'Browser reports your device is offline.',
          metric: 'Offline',
          detail: 'No active network interface detected by the browser.',
        });
        nextFindings.push({
          severity: 'fail',
          title: 'Device appears offline',
          explanation: 'Your browser is reporting no active network connection.',
          recommendation: 'Verify Wi-Fi or Ethernet is connected, or disable Airplane Mode.',
        });
      } else if (networkCtx.effectiveType === 'slow-2g' || networkCtx.effectiveType === '2g') {
        updateStage('adapter', {
          status: 'warn',
          summary: `Slow link profile detected (${networkCtx.effectiveType.toUpperCase()}).`,
          metric: `${networkCtx.effectiveType.toUpperCase()}`,
          detail: `Observed IP: ${observedIp}${networkCtx.downlinkMbps ? ` · ~${networkCtx.downlinkMbps} Mbps` : ''}`,
        });
        nextFindings.push({
          severity: 'warn',
          title: 'Very low bandwidth link detected',
          explanation: `Browser link estimation reports ${networkCtx.effectiveType.toUpperCase()} speeds.`,
          recommendation: 'Check cellular signal strength or switch from a throttled hotspot to Wi-Fi/Ethernet.',
        });
      } else {
        updateStage('adapter', {
          status: 'pass',
          summary: `Online · Observed IP ${observedIp}`,
          metric: networkCtx.effectiveType ? networkCtx.effectiveType.toUpperCase() : 'Online',
          detail: networkCtx.downlinkMbps
            ? `Estimated downlink ~${networkCtx.downlinkMbps} Mbps`
            : 'Active internet interface verified.',
        });
      }

      if (controller.signal.aborted) return;

      // Stage 2: 6-Probe Edge Burst
      const useCloudflareEdge =
        isNativeCapacitorOrigin() && (!getApiBaseUrl() || isAiStudioAuthGatedUrl(getApiBaseUrl()));
      const burstTarget = useCloudflareEdge ? 'https://1.1.1.1/cdn-cgi/trace' : '/api/ping';
      const burstLabel = useCloudflareEdge
        ? 'Cloudflare Edge (1.1.1.1)'
        : 'Current Server (/api/ping)';

      updateStage('edge-burst', {
        status: 'running',
        summary: `Sending 6 sequential probes to ${burstTarget}...`,
      });
      const burstSamples: PingSample[] = [];
      for (let seq = 1; seq <= 6; seq++) {
        const sample = await measureBrowserPing(
          burstTarget,
          burstLabel,
          seq,
          3000,
          controller.signal
        );
        burstSamples.push(sample);
        if (seq < 6) {
          await new Promise((r) => setTimeout(r, 120));
        }
      }

      if (controller.signal.aborted) return;

      const burstStats = computePingStats(burstSamples);
      if (burstStats.received === 0) {
        updateStage('edge-burst', {
          status: 'fail',
          summary: 'All 6 edge probes failed or timed out.',
          metric: '100% loss',
          detail: 'Your browser could not reach the application server.',
        });
        nextFindings.push({
          severity: 'fail',
          title: 'Cannot reach edge server from your network',
          explanation: '0 of 6 probes returned a response.',
          recommendation: 'Check firewall, VPN, captive portal login, or local internet connectivity.',
        });
      } else if (burstStats.lossPct > 0 || (burstStats.avgMs !== null && burstStats.avgMs > 250)) {
        updateStage('edge-burst', {
          status: 'warn',
          summary: `Avg ${formatMs(burstStats.avgMs)} · Packet loss ${burstStats.lossPct}% · Jitter ${formatMs(burstStats.jitterMs)}`,
          metric: formatMs(burstStats.avgMs),
          detail: `${burstStats.received}/${burstStats.sent} packets received.`,
        });
        if (burstStats.lossPct > 0) {
          nextFindings.push({
            severity: 'fail',
            title: `Packet loss detected (${burstStats.lossPct}%)`,
            explanation: `${burstStats.lost} of ${burstStats.sent} requests dropped or timed out during the burst.`,
            recommendation:
              'Move closer to your Wi-Fi router, test via Ethernet cable, or restart your modem/router.',
          });
        }
        if (burstStats.avgMs !== null && burstStats.avgMs > 250) {
          nextFindings.push({
            severity: 'warn',
            title: `High round-trip latency (${formatMs(burstStats.avgMs)})`,
            explanation: 'Baseline response time is above 250 ms.',
            recommendation:
              'Check if a VPN, cloud backup, or heavy download is saturating your upstream bandwidth.',
          });
        }
      } else {
        updateStage('edge-burst', {
          status: 'pass',
          summary: `Avg ${formatMs(burstStats.avgMs)} · 0% loss · Jitter ${formatMs(burstStats.jitterMs)}`,
          metric: formatMs(burstStats.avgMs),
          detail: `6/6 probes succeeded (Min ${formatMs(burstStats.minMs)}, Max ${formatMs(burstStats.maxMs)}).`,
        });
      }

      if (controller.signal.aborted) return;

      // Stage 3: IP vs Domain Reachability (DNS Isolation)
      updateStage('dns-reachability', {
        status: 'running',
        summary: 'Probing raw IP (1.1.1.1) and domain names (dns.google, github.com)...',
      });

      const [cfIpProbe, googleDnsProbe, githubProbe] = await Promise.all([
        measureBrowserPing('https://1.1.1.1/cdn-cgi/trace', '1.1.1.1', 1, 3500, controller.signal),
        measureBrowserPing(
          'https://dns.google/resolve?name=example.com&type=A',
          'dns.google',
          1,
          3500,
          controller.signal
        ),
        measureBrowserPing('https://github.com/favicon.ico', 'github.com', 1, 3500, controller.signal),
      ]);

      if (controller.signal.aborted) return;

      const ipOk = cfIpProbe.status === 'ok';
      const domainSuccessCount = [googleDnsProbe, githubProbe].filter((s) => s.status === 'ok').length;

      if (ipOk && domainSuccessCount === 0) {
        updateStage('dns-reachability', {
          status: 'fail',
          summary: `Direct IP 1.1.1.1 responded in ${formatMs(cfIpProbe.rttMs)}, but domain probes failed.`,
          metric: 'DNS Issue',
          detail: 'Raw IP connectivity works while hostname lookups failed.',
        });
        nextFindings.push({
          severity: 'fail',
          title: 'Local DNS resolution failure suspected',
          explanation: `Your network reached 1.1.1.1 by IP (${formatMs(cfIpProbe.rttMs)}), but both dns.google and github.com failed.`,
          recommendation:
            'Switch your device or router DNS servers to 1.1.1.1 (Cloudflare) or 8.8.8.8 (Google) and flush your OS DNS cache.',
        });
      } else if (!ipOk && domainSuccessCount === 0) {
        updateStage('dns-reachability', {
          status: 'fail',
          summary: 'External IP and domain probes both failed from your browser.',
          metric: 'Blocked / Down',
          detail: 'Could not reach 1.1.1.1, dns.google, or github.com.',
        });
        nextFindings.push({
          severity: 'fail',
          title: 'Public internet access appears blocked or down',
          explanation: 'Direct browser probes to Cloudflare, Google DNS, and GitHub all failed.',
          recommendation:
            'Check for a captive portal sign-in page, corporate proxy/firewall rules, or ISP outage.',
        });
      } else if (!ipOk || domainSuccessCount < 2) {
        const okLabels = [
          ipOk ? `1.1.1.1 (${formatMs(cfIpProbe.rttMs)})` : null,
          googleDnsProbe.status === 'ok' ? `dns.google (${formatMs(googleDnsProbe.rttMs)})` : null,
          githubProbe.status === 'ok' ? `github.com (${formatMs(githubProbe.rttMs)})` : null,
        ]
          .filter(Boolean)
          .join(', ');
        updateStage('dns-reachability', {
          status: 'warn',
          summary: `Partial reachability: ${okLabels}`,
          metric: `${(ipOk ? 1 : 0) + domainSuccessCount}/3 OK`,
          detail: 'One external provider timed out or was blocked by local network policy.',
        });
        nextFindings.push({
          severity: 'warn',
          title: 'Partial external endpoint failure',
          explanation: `Some public endpoints succeeded (${okLabels}) while another failed.`,
          recommendation:
            'Use Multi-Target to inspect which routes are failing; this often indicates an ISP peering or firewall filter issue.',
        });
      } else {
        updateStage('dns-reachability', {
          status: 'pass',
          summary: `1.1.1.1 (${formatMs(cfIpProbe.rttMs)}) · dns.google (${formatMs(googleDnsProbe.rttMs)}) · github.com (${formatMs(githubProbe.rttMs)})`,
          metric: '3/3 OK',
          detail: 'Both direct IP and domain-based HTTPS connections succeeded.',
        });
      }

      // Stage 4: Stability & Spike Ratio
      const jitter = burstStats.jitterMs ?? 0;
      const median = burstStats.medianMs ?? 0;
      const maxRtt = burstStats.maxMs ?? 0;
      const spikeDelta = maxRtt - median;

      if (burstStats.received < 2) {
        updateStage('stability', {
          status: 'fail',
          summary: 'Insufficient successful packets to evaluate jitter stability.',
          metric: '—',
          detail: 'Need at least 2 successful replies to measure variance.',
        });
      } else if (jitter > 35 || spikeDelta > 120) {
        updateStage('stability', {
          status: 'warn',
          summary: `Jitter ${formatMs(jitter)} · Peak spike +${formatMs(spikeDelta)} above median`,
          metric: formatMs(jitter),
          detail: 'Noticeable latency variance can cause choppy video calls or gaming lag.',
        });
        nextFindings.push({
          severity: 'warn',
          title: `Unstable latency / high jitter (${formatMs(jitter)})`,
          explanation: `Peak latency jumped ${formatMs(spikeDelta)} above your median (${formatMs(median)}).`,
          recommendation:
            'Switch from 2.4 GHz Wi-Fi to 5 GHz/6 GHz or Ethernet, and pause background uploads/downloads (bufferbloat).',
        });
      } else {
        updateStage('stability', {
          status: 'pass',
          summary: `Consistent timing · Jitter ${formatMs(jitter)} · Median ${formatMs(median)}`,
          metric: formatMs(jitter),
          detail: `Low variance across burst (peak within +${formatMs(spikeDelta)} of median).`,
        });
      }

      if (nextFindings.length === 0) {
        nextFindings.push({
          severity: 'ok',
          title: 'No local network faults detected',
          explanation: `Your connection is online with 0% packet loss, ${formatMs(burstStats.avgMs)} average edge latency, and ${formatMs(jitter)} jitter across all tested providers.`,
          recommendation:
            'If a specific website or app is still failing, test that exact domain below to see whether the issue is local to your network or on the remote server.',
        });
      }

      setFindings(nextFindings);
      setLastRunAt(Date.now());
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setFindings([
          {
            severity: 'fail',
            title: 'Diagnostic check interrupted',
            explanation: err instanceof Error ? err.message : 'Unexpected error while probing.',
            recommendation: 'Click Re-run Diagnostic to try again.',
          },
        ]);
      }
    } finally {
      setIsRunning(false);
    }
  }, [networkCtx.downlinkMbps, networkCtx.effectiveType, networkCtx.observedIp]);

  useEffect(() => {
    if (hasAutoRunRef.current) return;
    hasAutoRunRef.current = true;
    void runDiagnostics();
    return () => {
      abortRef.current?.abort();
    };
  }, [runDiagnostics]);

  const handleSiteComparison = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeBrowserProbeUrl(siteInput);
    if (!normalized.ok) {
      setSiteError(normalized.error);
      return;
    }

    setSiteError(null);
    setSiteLoading(true);
    setSiteComparison(null);

    const cleanHost = normalized.displayTarget.split(':')[0];

    try {
      const [browserSample, dnsRes] = await Promise.all([
        measureBrowserPing(normalized.url, normalized.displayTarget, 1, 3500),
        fetch(apiUrl('/api/probe/dns'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: cleanHost }),
        })
          .then((r) => r.json() as Promise<DnsLookupResult>)
          .catch(
            (): DnsLookupResult => ({
              ok: false,
              host: cleanHost,
              error: 'NetPulse cloud server unreachable from standalone APK (connect server in TV Transfer tab).',
            })
          ),
      ]);

      let serverTcpSample: PingSample | null = null;
      if (dnsRes.ok) {
        serverTcpSample = await measureServerTcpPing(dnsRes.host, 443, 1).catch(() => null);
      }

      const browserOk = browserSample.status === 'ok';
      const serverOk = serverTcpSample?.status === 'ok';

      let verdict = '';
      let verdictSeverity: 'ok' | 'warn' | 'fail' = 'ok';

      if (browserOk && serverOk) {
        verdict = `Reachable from both your network (${formatMs(browserSample.rttMs)}) and the cloud server (${formatMs(serverTcpSample?.rttMs)}).`;
        verdictSeverity = 'ok';
      } else if (!browserOk && serverOk) {
        verdict = `Server reached ${cleanHost}:443 in ${formatMs(serverTcpSample?.rttMs)}, but your browser failed (${browserSample.note || browserSample.status}). This points to a local DNS, firewall, VPN, or ISP routing block on your network.`;
        verdictSeverity = 'fail';
      } else if (browserOk && !serverOk) {
        verdict = `Your browser reached ${normalized.displayTarget} (${formatMs(browserSample.rttMs)}), while cloud server TCP:443 check reported: ${serverTcpSample?.note || dnsRes.error || 'blocked/unreachable'}.`;
        verdictSeverity = 'warn';
      } else {
        verdict = `Both your browser and the cloud server failed to reach ${cleanHost}. The domain may be misconfigured, offline, or non-public.`;
        verdictSeverity = 'fail';
      }

      setSiteComparison({
        domain: cleanHost,
        browserSample,
        dnsResult: dnsRes,
        serverTcpSample,
        verdict,
        verdictSeverity,
      });
    } catch (err) {
      setSiteError(err instanceof Error ? err.message : 'Comparison probe failed.');
    } finally {
      setSiteLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Automated 4-Stage Diagnostic Runner */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              Network Health &amp; Problem Diagnostic
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Runs real probes from your browser to check link status, packet loss, jitter, and DNS
              versus external reachability.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {lastRunAt && (
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                Last check: {new Date(lastRunAt).toLocaleTimeString()}
              </span>
            )}
            <button
              type="button"
              onClick={() => void runDiagnostics()}
              disabled={isRunning}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${isRunning ? 'animate-spin' : ''}`} />
              {isRunning ? 'Running Checks...' : 'Re-run Diagnostic'}
            </button>
          </div>
        </div>

        {/* Findings Summary */}
        {findings.length > 0 && (
          <div className="mt-5 space-y-3">
            {findings.map((finding, idx) => (
              <div
                key={idx}
                className={`p-4 rounded-lg border ${
                  finding.severity === 'ok'
                    ? 'border-emerald-200 bg-emerald-50/50'
                    : finding.severity === 'warn'
                      ? 'border-amber-200 bg-amber-50/50'
                      : 'border-red-200 bg-red-50/50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{finding.title}</div>
                    <p className="mt-1 text-sm text-slate-700">{finding.explanation}</p>
                    <p className="mt-1.5 text-xs text-slate-600">
                      <span className="font-semibold text-slate-800">Next step:</span>{' '}
                      {finding.recommendation}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium shrink-0 ${
                      finding.severity === 'ok'
                        ? 'text-emerald-700'
                        : finding.severity === 'warn'
                          ? 'text-amber-700'
                          : 'text-red-700'
                    }`}
                  >
                    {finding.severity === 'ok'
                      ? 'Healthy'
                      : finding.severity === 'warn'
                        ? 'Warning'
                        : 'Problem Found'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 4-Stage Diagnostic Table */}
        <div className="mt-6 divide-y divide-slate-200 border border-slate-200 rounded-lg">
          {stages.map((stage) => (
            <div
              key={stage.id}
              className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-semibold text-slate-900">{stage.title}</span>
                  <StatusLabel status={stage.status} />
                </div>
                <p className="mt-1 text-sm text-slate-700">{stage.summary}</p>
                <p className="mt-0.5 text-xs text-slate-500">{stage.detail}</p>
              </div>
              <div className="text-left sm:text-right shrink-0">
                <div className="text-sm font-semibold font-mono tabular-nums text-slate-900">
                  {stage.metric}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Side-by-side Failing Website Isolation */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="pb-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            Isolate a Failing Site: Your Network vs. Cloud Server
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Having trouble loading a specific domain? Test it from both your browser and our cloud
            server simultaneously to see whether the problem is local to your connection.
          </p>
        </div>

        <form onSubmit={handleSiteComparison} className="mt-5 flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label htmlFor="isolate-site-input" className="sr-only">
              Domain to isolate
            </label>
            <input
              id="isolate-site-input"
              type="text"
              value={siteInput}
              onChange={(e) => setSiteInput(e.target.value)}
              placeholder="Enter a site that isn't working (e.g. github.com, cloudflare.com, openai.com)"
              className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
            {siteError && <p className="mt-1.5 text-xs text-red-600">{siteError}</p>}
          </div>
          <button
            type="submit"
            disabled={siteLoading}
            className="inline-flex items-center justify-center gap-2 h-10 px-4 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Search className="w-4 h-4" />
            {siteLoading ? 'Comparing...' : 'Test Both Paths'}
          </button>
        </form>

        {siteComparison && (
          <div className="mt-5 space-y-4">
            <div
              className={`p-4 rounded-lg border text-sm ${
                siteComparison.verdictSeverity === 'ok'
                  ? 'border-emerald-200 bg-emerald-50/50 text-slate-800'
                  : siteComparison.verdictSeverity === 'warn'
                    ? 'border-amber-200 bg-amber-50/50 text-slate-800'
                    : 'border-red-200 bg-red-50/50 text-slate-800'
              }`}
            >
              <span className="font-semibold text-slate-900">Diagnosis: </span>
              {siteComparison.verdict}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-slate-200 rounded-lg p-4">
                <div className="text-xs font-medium text-slate-500">Path A — Your Browser Network</div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span
                    className={`text-sm font-semibold ${
                      siteComparison.browserSample.status === 'ok'
                        ? 'text-emerald-700'
                        : 'text-red-700'
                    }`}
                  >
                    {siteComparison.browserSample.status === 'ok'
                      ? 'Reachable'
                      : siteComparison.browserSample.status.toUpperCase()}
                  </span>
                  <span className="text-lg font-semibold font-mono tabular-nums text-slate-900">
                    {formatMs(siteComparison.browserSample.rttMs)}
                  </span>
                </div>
                <div className="mt-2 text-xs text-slate-500 font-mono">
                  {siteComparison.browserSample.protocol}
                  {siteComparison.browserSample.note ? ` · ${siteComparison.browserSample.note}` : ''}
                </div>
                <button
                  type="button"
                  onClick={() => onOpenLivePing(siteComparison.domain)}
                  className="mt-3 text-xs font-medium text-blue-700 hover:underline"
                >
                  Run continuous ping on {siteComparison.domain}
                </button>
              </div>

              <div className="border border-slate-200 rounded-lg p-4">
                <div className="text-xs font-medium text-slate-500">
                  Path B — Cloud Server DNS &amp; TCP:443
                </div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span
                    className={`text-sm font-semibold ${
                      siteComparison.serverTcpSample?.status === 'ok'
                        ? 'text-emerald-700'
                        : 'text-red-700'
                    }`}
                  >
                    {siteComparison.serverTcpSample?.status === 'ok'
                      ? 'TCP Open'
                      : siteComparison.dnsResult.ok
                        ? siteComparison.serverTcpSample?.note || 'TCP Failed'
                        : siteComparison.dnsResult.error || 'DNS Failed'}
                  </span>
                  <span className="text-lg font-semibold font-mono tabular-nums text-slate-900">
                    {formatMs(siteComparison.serverTcpSample?.rttMs)}
                  </span>
                </div>
                <div className="mt-2 text-xs text-slate-500 font-mono">
                  {siteComparison.dnsResult.ok && siteComparison.dnsResult.ipv4?.length
                    ? `DNS: ${siteComparison.dnsResult.ipv4[0]} (${formatMs(siteComparison.dnsResult.resolveMs)})`
                    : siteComparison.dnsResult.error || 'No IPv4 record'}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
