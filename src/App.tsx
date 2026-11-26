import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Play, RotateCcw, Square } from 'lucide-react';
import { DnsTcpInspector } from './components/DnsTcpInspector';
import { LanDevicesInspector } from './components/LanDevicesInspector';
import { LatencyChart } from './components/LatencyChart';
import { MultiTargetMatrix } from './components/MultiTargetMatrix';
import { NetworkDiagnostics } from './components/NetworkDiagnostics';
import { SessionHistory } from './components/SessionHistory';
import { TvReceiverView } from './components/TvReceiverView';
import { TvTransferPanel } from './components/TvTransferPanel';
import type {
  ClientNetworkContext,
  NavSection,
  PingSample,
  ProbeMode,
  SavedSessionRun,
} from './types/network';
import {
  BROWSER_PRESETS,
  SERVER_TCP_PRESETS,
  computePingStats,
  exportSamplesCsv,
  formatMs,
  measureBrowserPing,
  measureServerTcpPing,
  normalizeBrowserProbeUrl,
} from './utils/networkProbes';
import { apiUrl, getApiBaseUrl, isAiStudioAuthGatedUrl, isNativeCapacitorOrigin } from './utils/apiUrl';

const HISTORY_STORAGE_KEY = 'netpulse_session_history_v1';

interface NetworkInformationLike {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

function getNavigatorConnection(): NetworkInformationLike | undefined {
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };
  return nav.connection || nav.mozConnection || nav.webkitConnection;
}

function getInitialRouteState(): {
  tvMode: boolean;
  tvCode?: string;
  nav: NavSection;
} {
  if (typeof window === 'undefined') {
    return { tvMode: false, nav: 'tv-transfer' };
  }
  const params = new URLSearchParams(window.location.search);
  const tvParam = params.get('tv');
  const roomParam = params.get('room');
  const navParam = params.get('nav') as NavSection | null;

  if (tvParam !== null) {
    const cleanCode = /^\d{6}$/.test(tvParam) ? tvParam : undefined;
    return { tvMode: true, tvCode: cleanCode, nav: 'tv-transfer' };
  }

  const validNavs: NavSection[] = ['tv-transfer', 'lan-devices', 'diagnose', 'live', 'multi', 'dns-tcp'];
  const cleanRoom = roomParam && /^\d{6}$/.test(roomParam) ? roomParam : undefined;
  const resolvedNav =
    navParam && validNavs.includes(navParam) ? navParam : cleanRoom ? 'tv-transfer' : 'tv-transfer';

  return { tvMode: false, tvCode: cleanRoom, nav: resolvedNav };
}

export default function App() {
  const initialRoute = useMemo(() => getInitialRouteState(), []);
  const [tvReceiverMode, setTvReceiverMode] = useState(initialRoute.tvMode);
  const [tvRoomCode, setTvRoomCode] = useState<string | undefined>(initialRoute.tvCode);
  const [activeNav, setActiveNav] = useState<NavSection>(initialRoute.nav);
  const [mode, setMode] = useState<ProbeMode>('browser');
  const [targetInput, setTargetInput] = useState(() =>
    isNativeCapacitorOrigin() && (!getApiBaseUrl() || isAiStudioAuthGatedUrl(getApiBaseUrl()))
      ? 'https://1.1.1.1/cdn-cgi/trace'
      : '/api/ping'
  );
  const [tcpPort, setTcpPort] = useState<number>(443);
  const [packetLimit, setPacketLimit] = useState<number>(10); // 0 = continuous
  const [intervalMs, setIntervalMs] = useState<number>(1000);

  const [isRunning, setIsRunning] = useState(false);
  const [samples, setSamples] = useState<PingSample[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);
  const [networkCtx, setNetworkCtx] = useState<ClientNetworkContext>({
    observedIp: 'Detecting...',
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  });

  const [history, setHistory] = useState<SavedSessionRun[]>(() => {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const startedAtRef = useRef<number>(Date.now());
  const activeRunMetaRef = useRef<{ mode: ProbeMode; target: string; port?: number } | null>(null);
  const samplesRef = useRef<PingSample[]>([]);

  useEffect(() => {
    samplesRef.current = samples;
  }, [samples]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 30)));
    } catch {
      // Ignore storage quota errors
    }
  }, [history]);

  // Detect client network context (real observed IP + browser connection info)
  useEffect(() => {
    let active = true;

    const refreshNetworkContext = async () => {
      const conn = getNavigatorConnection();
      let observedIp = networkCtx.observedIp;
      try {
        const res = await fetch(apiUrl('/api/network-info'), { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (typeof data.observedIp === 'string') {
            observedIp = data.observedIp;
          }
        }
      } catch {
        if (observedIp === 'Detecting...') {
          observedIp = 'Unavailable';
        }
      }
      if (!active) return;
      setNetworkCtx({
        observedIp,
        effectiveType: conn?.effectiveType,
        downlinkMbps: conn?.downlink,
        hardwareRttMs: conn?.rtt,
        saveData: conn?.saveData,
        online: navigator.onLine,
      });
    };

    void refreshNetworkContext();

    const handleOnlineChange = () => void refreshNetworkContext();
    window.addEventListener('online', handleOnlineChange);
    window.addEventListener('offline', handleOnlineChange);
    const conn = getNavigatorConnection();
    conn?.addEventListener?.('change', handleOnlineChange);

    return () => {
      active = false;
      window.removeEventListener('online', handleOnlineChange);
      window.removeEventListener('offline', handleOnlineChange);
      conn?.removeEventListener?.('change', handleOnlineChange);
    };
  }, []);

  const stats = useMemo(() => computePingStats(samples), [samples]);

  const saveCompletedRun = useCallback((collected: PingSample[], meta: { mode: ProbeMode; target: string; port?: number }) => {
    if (collected.length === 0) return;
    const runStats = computePingStats(collected);
    const run: SavedSessionRun = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      startedAt: startedAtRef.current,
      endedAt: Date.now(),
      mode: meta.mode,
      target: meta.target,
      port: meta.port,
      stats: runStats,
      samples: collected,
    };
    setHistory((prev) => [run, ...prev].slice(0, 30));
  }, []);

  const stopPing = useCallback(() => {
    if (!runningRef.current) return;
    runningRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsRunning(false);
    if (activeRunMetaRef.current && samplesRef.current.length > 0) {
      saveCompletedRun(samplesRef.current, activeRunMetaRef.current);
      activeRunMetaRef.current = null;
    }
  }, [saveCompletedRun]);

  const startPing = useCallback(
    async (
      overrideTarget?: string,
      overrideMode?: ProbeMode,
      overridePort?: number,
      overrideLimit?: number
    ) => {
      if (runningRef.current) {
        stopPing();
      }

      const activeMode = overrideMode ?? mode;
      const rawTarget = (overrideTarget ?? targetInput).trim();
      const activePort = overridePort ?? tcpPort;
      const activeLimit = overrideLimit ?? packetLimit;

      let displayTarget = rawTarget;
      let browserProbeUrl = rawTarget;

      if (activeMode === 'browser') {
        const normalized = normalizeBrowserProbeUrl(rawTarget);
        if (!normalized.ok) {
          setInputError(normalized.error);
          return;
        }
        browserProbeUrl = normalized.url;
        displayTarget = normalized.displayTarget;
      } else {
        if (!rawTarget) {
          setInputError('Please enter a public hostname or IP address.');
          return;
        }
      }

      setInputError(null);
      setSamples([]);
      samplesRef.current = [];
      startedAtRef.current = Date.now();
      activeRunMetaRef.current = {
        mode: activeMode,
        target: displayTarget,
        port: activeMode === 'server-tcp' ? activePort : undefined,
      };

      const controller = new AbortController();
      abortRef.current = controller;
      runningRef.current = true;
      setIsRunning(true);

      let seq = 1;
      const collected: PingSample[] = [];

      try {
        while (runningRef.current && !controller.signal.aborted) {
          if (activeLimit > 0 && seq > activeLimit) {
            break;
          }

          let sample: PingSample;
          if (activeMode === 'browser') {
            sample = await measureBrowserPing(
              browserProbeUrl,
              displayTarget,
              seq,
              3500,
              controller.signal
            );
          } else {
            sample = await measureServerTcpPing(rawTarget, activePort, seq, controller.signal);
          }

          if (!runningRef.current || controller.signal.aborted) {
            break;
          }

          collected.push(sample);
          samplesRef.current = [...collected];
          setSamples([...collected]);

          if (activeLimit > 0 && seq >= activeLimit) {
            break;
          }

          seq += 1;

          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, intervalMs);
            controller.signal.addEventListener(
              'abort',
              () => {
                window.clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setInputError(err instanceof Error ? err.message : 'Ping execution stopped due to an error.');
        }
      } finally {
        const wasRunning = runningRef.current;
        runningRef.current = false;
        abortRef.current = null;
        setIsRunning(false);
        if (wasRunning && collected.length > 0 && activeRunMetaRef.current) {
          saveCompletedRun(collected, activeRunMetaRef.current);
          activeRunMetaRef.current = null;
        }
      }
    },
    [mode, targetInput, tcpPort, packetLimit, intervalMs, stopPing, saveCompletedRun]
  );

  // Clean up active ping on unmount
  useEffect(() => {
    return () => {
      runningRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const handleModeChange = (nextMode: ProbeMode) => {
    if (isRunning) stopPing();
    setMode(nextMode);
    setInputError(null);
    if (nextMode === 'browser') {
      setTargetInput('/api/ping');
    } else {
      setTargetInput('1.1.1.1');
      setTcpPort(443);
    }
  };

  const handleHeaderAction = () => {
    if (activeNav !== 'live') {
      setActiveNav('live');
      if (!isRunning) {
        void startPing();
      }
      return;
    }
    if (isRunning) {
      stopPing();
    } else {
      void startPing();
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void startPing();
  };

  const handleRetestFromHistory = (run: SavedSessionRun) => {
    setActiveNav('live');
    setMode(run.mode);
    const nextTarget =
      run.target === 'Current Server (/api/ping)' ? '/api/ping' : run.target;
    setTargetInput(nextTarget);
    if (run.port) setTcpPort(run.port);
    void startPing(nextTarget, run.mode, run.port ?? 443);
  };

  const activePresets = mode === 'browser' ? BROWSER_PRESETS : SERVER_TCP_PRESETS;

  if (tvReceiverMode) {
    return (
      <TvReceiverView
        initialCode={tvRoomCode}
        onExitTvMode={(activeCode) => {
          setTvRoomCode(activeCode);
          setTvReceiverMode(false);
          setActiveNav('tv-transfer');
          if (typeof window !== 'undefined') {
            window.history.replaceState(
              null,
              '',
              activeCode ? `/?nav=tv-transfer&room=${activeCode}` : '/'
            );
          }
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: [Brand title, one line] — [4 nav links] — [1 primary action] */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#live"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('live');
            }}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            NetPulse
          </a>

          <nav className="flex items-center gap-5 overflow-x-auto text-sm font-medium">
            {(
              [
                { id: 'tv-transfer', label: 'TV Transfer' },
                { id: 'lan-devices', label: 'LAN Devices' },
                { id: 'diagnose', label: 'Diagnose' },
                { id: 'live', label: 'Live Ping' },
                { id: 'multi', label: 'Multi-Target' },
                { id: 'dns-tcp', label: 'DNS & TCP' },
              ] as const
            ).map((item) => {
              const active = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveNav(item.id)}
                  className={`py-1 whitespace-nowrap shrink-0 border-b-2 transition-colors ${
                    active
                      ? 'border-blue-600 text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleHeaderAction}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                isRunning && activeNav === 'live'
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {isRunning && activeNav === 'live' ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  Stop Ping
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Run Ping
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Observed Network Context Strip (clean unboxed metadata, no pills) */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-slate-600 border-b border-slate-200 pb-4">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-medium text-slate-900">
              {networkCtx.online ? 'Network Online' : 'Network Offline'}
            </span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="font-mono tabular-nums">
              Observed IP: {networkCtx.observedIp}
            </span>
            {networkCtx.effectiveType && (
              <>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="font-mono tabular-nums">
                  Link: {networkCtx.effectiveType.toUpperCase()}
                  {networkCtx.downlinkMbps ? ` (~${networkCtx.downlinkMbps} Mbps)` : ''}
                </span>
              </>
            )}
            {typeof networkCtx.hardwareRttMs === 'number' && networkCtx.hardwareRttMs > 0 && (
              <>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="font-mono tabular-nums">
                  Browser RTT Est: {networkCtx.hardwareRttMs} ms
                </span>
              </>
            )}
          </div>
          <div className="text-slate-500">
            {mode === 'browser'
              ? 'Probe Origin: Your Browser Network (HTTP/TLS Timing)'
              : 'Probe Origin: Cloud Server (DNS + TCP Handshake)'}
          </div>
        </div>

        {activeNav === 'diagnose' && (
          <NetworkDiagnostics
            networkCtx={networkCtx}
            onOpenLivePing={(target) => {
              setActiveNav('live');
              setMode('browser');
              setTargetInput(target);
              void startPing(target, 'browser', 443);
            }}
          />
        )}

        {activeNav === 'live' && (
          <>
            {/* Workspace Control Bar */}
            <section className="bg-white border border-slate-200 rounded-lg p-5 sm:p-6 space-y-5">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div>
                  <h1 className="text-xl font-semibold text-slate-900 text-balance">
                    Network Latency &amp; Ping Console
                  </h1>
                  <p className="mt-1 text-sm text-slate-600">
                    Measure real round-trip time, jitter, and packet loss from your local connection
                    or verify public endpoints via server TCP handshakes.
                  </p>
                </div>

                {/* Interactive Mode Segmented Control */}
                <div
                  className="inline-flex items-center p-1 bg-slate-100 rounded-lg shrink-0 self-start lg:self-auto"
                  role="tablist"
                  aria-label="Probe origin mode"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'browser'}
                    onClick={() => handleModeChange('browser')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      mode === 'browser'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    My Network (Browser)
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'server-tcp'}
                    onClick={() => handleModeChange('server-tcp')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      mode === 'server-tcp'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Cloud Probe (Server TCP)
                  </button>
                </div>
              </div>

              <form onSubmit={handleFormSubmit} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                <div className={mode === 'server-tcp' ? 'md:col-span-5' : 'md:col-span-6'}>
                  <label htmlFor="ping-target-input" className="block text-xs font-medium text-slate-600 mb-1.5">
                    {mode === 'browser'
                      ? 'Target URL, Domain, or Local IP'
                      : 'Public Hostname or IP'}
                  </label>
                  <input
                    id="ping-target-input"
                    type="text"
                    value={targetInput}
                    onChange={(e) => setTargetInput(e.target.value)}
                    placeholder={
                      mode === 'browser'
                        ? '/api/ping, 1.1.1.1, github.com, or 192.168.1.1'
                        : 'e.g. 1.1.1.1 or cloudflare.com'
                    }
                    className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>

                {mode === 'server-tcp' && (
                  <div className="md:col-span-1">
                    <label htmlFor="ping-tcp-port" className="block text-xs font-medium text-slate-600 mb-1.5">
                      Port
                    </label>
                    <input
                      id="ping-tcp-port"
                      type="number"
                      min={1}
                      max={65535}
                      value={tcpPort}
                      onChange={(e) =>
                        setTcpPort(Math.max(1, Math.min(65535, Number(e.target.value) || 443)))
                      }
                      className="w-full h-10 px-2.5 text-sm bg-white border border-slate-200 rounded-md text-slate-900 font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                )}

                <div className="md:col-span-2">
                  <label htmlFor="ping-count-select" className="block text-xs font-medium text-slate-600 mb-1.5">
                    Count
                  </label>
                  <select
                    id="ping-count-select"
                    value={packetLimit}
                    onChange={(e) => setPacketLimit(Number(e.target.value))}
                    className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  >
                    <option value={5}>5 pings</option>
                    <option value={10}>10 pings</option>
                    <option value={25}>25 pings</option>
                    <option value={50}>50 pings</option>
                    <option value={0}>Continuous</option>
                  </select>
                </div>

                <div className="md:col-span-2">
                  <label htmlFor="ping-interval-select" className="block text-xs font-medium text-slate-600 mb-1.5">
                    Interval
                  </label>
                  <select
                    id="ping-interval-select"
                    value={intervalMs}
                    onChange={(e) => setIntervalMs(Number(e.target.value))}
                    className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  >
                    <option value={500}>500 ms</option>
                    <option value={1000}>1.0 sec</option>
                    <option value={2000}>2.0 sec</option>
                  </select>
                </div>

                <div className="md:col-span-2 flex items-center gap-2">
                  <button
                    type="submit"
                    className={`flex-1 h-10 px-4 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                      isRunning
                        ? 'bg-slate-900 text-white hover:bg-slate-800'
                        : 'bg-blue-600 text-white hover:bg-blue-700'
                    }`}
                  >
                    {isRunning ? 'Restart' : 'Start Ping'}
                  </button>
                  {isRunning && (
                    <button
                      type="button"
                      onClick={stopPing}
                      aria-label="Stop active ping"
                      className="h-10 px-3 text-sm font-medium text-red-700 bg-white border border-red-200 rounded-md hover:bg-red-50 transition-colors whitespace-nowrap"
                    >
                      Stop
                    </button>
                  )}
                </div>
              </form>

              {inputError && (
                <p className="text-xs font-medium text-red-600">{inputError}</p>
              )}

              {/* Quick Target Presets */}
              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                <span className="text-slate-500 mr-1">Targets:</span>
                {activePresets.map((preset) => {
                  const presetVal =
                    mode === 'browser' ? preset.browserUrl ?? preset.target : preset.tcpHost ?? preset.target;
                  const isSelected = targetInput.trim() === presetVal;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setTargetInput(presetVal);
                        if (mode === 'server-tcp' && preset.defaultPort) {
                          setTcpPort(preset.defaultPort);
                        }
                        void startPing(
                          presetVal,
                          mode,
                          preset.defaultPort ?? tcpPort
                        );
                      }}
                      title={preset.description}
                      className={`px-2.5 py-1 rounded border transition-colors whitespace-nowrap shrink-0 ${
                        isSelected
                          ? 'border-blue-600 bg-blue-50 text-blue-700 font-medium'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Primary Focal Anchor: 4-Column KPI Strip + Latency Waveform */}
            <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 sm:divide-x divide-slate-200 border-b border-slate-200">
                <div className="p-5">
                  <div className="text-xs font-medium text-slate-500">Latest RTT</div>
                  <div className="mt-1.5 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                    {formatMs(stats.latestMs)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                    {isRunning
                      ? `Probing seq #${samples.length + 1}${packetLimit > 0 ? ` of ${packetLimit}` : ''}`
                      : samples.length > 0
                        ? `Completed ${samples.length} probes`
                        : 'Idle'}
                  </div>
                </div>

                <div className="p-5">
                  <div className="text-xs font-medium text-slate-500">Average &amp; Jitter</div>
                  <div className="mt-1.5 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                    {formatMs(stats.avgMs)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                    Jitter (mdev): {formatMs(stats.jitterMs)}
                  </div>
                </div>

                <div className="p-5">
                  <div className="text-xs font-medium text-slate-500">Min / P95 / Max</div>
                  <div className="mt-1.5 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                    {stats.minMs !== null ? `${stats.minMs.toFixed(1)} ms` : '—'}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                    P95: {formatMs(stats.p95Ms)} · Max: {formatMs(stats.maxMs)}
                  </div>
                </div>

                <div className="p-5">
                  <div className="text-xs font-medium text-slate-500">Packet Loss</div>
                  <div
                    className={`mt-1.5 text-2xl font-semibold font-mono tabular-nums ${
                      stats.sent === 0
                        ? 'text-slate-900'
                        : stats.lossPct === 0
                          ? 'text-emerald-700'
                          : stats.lossPct < 20
                            ? 'text-amber-700'
                            : 'text-red-700'
                    }`}
                  >
                    {stats.sent > 0 ? `${stats.lossPct}%` : '—'}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                    {stats.received} received / {stats.sent} sent
                  </div>
                </div>
              </div>

              <div className="p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">
                      Round-Trip Latency Trace
                    </h2>
                    <p className="text-xs text-slate-500">
                      Showing up to last 60 probes · Hover nodes for exact packet telemetry
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => exportSamplesCsv(samples)}
                      disabled={samples.length === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isRunning) stopPing();
                        setSamples([]);
                      }}
                      disabled={samples.length === 0 && !isRunning}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Clear
                    </button>
                  </div>
                </div>

                <LatencyChart samples={samples} avgMs={stats.avgMs} isRunning={isRunning} />
              </div>
            </section>

            {/* Live Sequence Log Table */}
            <section className="bg-white border border-slate-200 rounded-lg p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">Sequence Log</h2>
                  <p className="text-xs text-slate-500">
                    Individual probe responses ordered most recent first
                  </p>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {samples.length} {samples.length === 1 ? 'sample' : 'samples'}
                </span>
              </div>

              {samples.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-500">
                  Probe sequence details will populate here as packets arrive.
                </div>
              ) : (
                <div className="mt-3 overflow-x-auto max-h-[340px] overflow-y-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                        <th className="py-2 pr-4">Seq</th>
                        <th className="py-2 px-3">Timestamp</th>
                        <th className="py-2 px-3">Target</th>
                        <th className="py-2 px-3">Protocol</th>
                        <th className="py-2 px-3">Status</th>
                        <th className="py-2 pl-3 text-right">RTT</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs font-mono tabular-nums">
                      {[...samples].reverse().map((s) => (
                        <tr key={s.seq} className="hover:bg-slate-50/70 transition-colors">
                          <td className="py-2.5 pr-4 text-slate-500">#{s.seq}</td>
                          <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                            {new Date(s.timestamp).toLocaleTimeString()}
                          </td>
                          <td className="py-2.5 px-3 text-slate-900">
                            {s.target}
                            {s.resolvedIp ? ` (${s.resolvedIp})` : ''}
                          </td>
                          <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                            {s.protocol}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            {s.status === 'ok' ? (
                              <span className="font-medium text-emerald-700">OK</span>
                            ) : s.status === 'timeout' ? (
                              <span className="font-medium text-red-700">Timeout</span>
                            ) : s.status === 'blocked' ? (
                              <span className="font-medium text-amber-700">
                                Blocked {s.note ? `— ${s.note}` : ''}
                              </span>
                            ) : (
                              <span className="font-medium text-red-700">
                                Error {s.note ? `— ${s.note}` : ''}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pl-3 text-right font-semibold text-slate-900 whitespace-nowrap">
                            {formatMs(s.rttMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <SessionHistory
              runs={history}
              onClearAll={() => setHistory([])}
              onLoadTarget={handleRetestFromHistory}
            />
          </>
        )}

        {activeNav === 'tv-transfer' && (
          <TvTransferPanel
            initialRoomCode={tvRoomCode}
            onOpenTvReceiver={(code) => {
              setTvRoomCode(code);
              setTvReceiverMode(true);
              if (typeof window !== 'undefined' && code) {
                window.history.replaceState(null, '', `/?tv=${code}`);
              }
            }}
          />
        )}

        {activeNav === 'multi' && <MultiTargetMatrix />}

        {activeNav === 'dns-tcp' && <DnsTcpInspector />}

        {activeNav === 'lan-devices' && <LanDevicesInspector />}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-500">
          <span>
            NetPulse · Browser probes measure real HTTP/TLS round-trip time from your network;
            server probes verify public DNS and TCP handshakes.
          </span>
          <span>Browsers restrict raw ICMP packets and HTTP access to local LAN IPs from HTTPS pages.</span>
        </div>
      </footer>
    </div>
  );
}
