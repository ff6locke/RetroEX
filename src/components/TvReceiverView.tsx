import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Download, FileBox, Film, Package, RefreshCw, Tv } from 'lucide-react';
import type { TvTransferFileItem, TvTransferRoom } from '../types/network';
import { QrCodeSvg } from './QrCodeSvg';
import {
  apiUrl,
  getApiBaseUrl,
  getPublicAppOrigin,
  isAiStudioAuthGatedUrl,
  isNativeCapacitorOrigin,
  setSavedApiBaseOverride,
} from '../utils/apiUrl';

interface TvReceiverViewProps {
  initialCode?: string;
  onExitTvMode: (activeCode?: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fileCategoryLabel(file: TvTransferFileItem): string {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.apk') || lower.endsWith('.xapk') || lower.endsWith('.apks')) {
    return 'Android APK';
  }
  if (/\.(mp4|mkv|mov|avi|webm)$/i.test(lower)) return 'Video';
  if (/\.(mp3|flac|aac|wav)$/i.test(lower)) return 'Audio';
  if (/\.(srt|vtt|ass)$/i.test(lower)) return 'Subtitles';
  if (/\.(zip|tar|gz)$/i.test(lower)) return 'Archive';
  return 'File';
}

function FileIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (/\.(apk|xapk|apks)$/i.test(lower)) {
    return <Package className="w-6 h-6 text-emerald-400 shrink-0" />;
  }
  if (/\.(mp4|mkv|mov|avi|webm)$/i.test(lower)) {
    return <Film className="w-6 h-6 text-blue-400 shrink-0" />;
  }
  return <FileBox className="w-6 h-6 text-slate-300 shrink-0" />;
}

export function TvReceiverView({ initialCode, onExitTvMode }: TvReceiverViewProps) {
  const [room, setRoom] = useState<TvTransferRoom | null>(null);
  const [joinInput, setJoinInput] = useState(initialCode || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);

  const [serverUrlInput, setServerUrlInput] = useState(() => getApiBaseUrl());
  const [needsServerConfig, setNeedsServerConfig] = useState(false);

  const formatRoomError = useCallback((err: unknown, fallback: string): string => {
    const msg = err instanceof Error ? err.message : fallback;
    const base = getApiBaseUrl();
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      if (isNativeCapacitorOrigin() && (!base || isAiStudioAuthGatedUrl(base))) {
        setNeedsServerConfig(true);
        return 'Cannot connect from APK: the AI Studio dev URL requires Google login cookies. Enter your deployed public NetPulse URL or local LAN server (e.g. http://192.168.1.10:3000) below.';
      }
      setNeedsServerConfig(true);
      return `Unable to reach NetPulse server (${base || 'same origin'}). Check Wi-Fi or enter your server URL below.`;
    }
    return msg;
  }, []);

  const createNewRoom = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/tv/rooms'), { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || 'Unable to start a TV receiver session.');
        return;
      }
      setNeedsServerConfig(false);
      setRoom(data.room);
      setJoinInput(data.room.code);
    } catch (err) {
      setError(formatRoomError(err, 'Network error starting TV room.'));
    } finally {
      setLoading(false);
    }
  }, [formatRoomError]);

  const joinRoomByCode = useCallback(
    async (code: string, fallbackToCreate = false) => {
      const clean = code.replace(/\D/g, '').slice(0, 6);
      if (clean.length !== 6) {
        setError('Enter a valid 6-digit pairing code.');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(apiUrl(`/api/tv/rooms/${clean}`), { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (fallbackToCreate) {
            await createNewRoom();
            return;
          }
          setError(data.error || `Room ${clean} was not found or expired.`);
          return;
        }
        setNeedsServerConfig(false);
        setRoom(data.room);
        setJoinInput(data.room.code);
      } catch (err) {
        setError(formatRoomError(err, 'Unable to connect to room.'));
      } finally {
        setLoading(false);
      }
    },
    [createNewRoom, formatRoomError]
  );

  useEffect(() => {
    if (initialCode && /^\d{6}$/.test(initialCode)) {
      void joinRoomByCode(initialCode, true);
    } else {
      void createNewRoom();
    }
  }, [initialCode, joinRoomByCode, createNewRoom]);

  // Live SSE subscription for incoming files
  useEffect(() => {
    if (!room?.code) return;
    const source = new EventSource(apiUrl(`/api/tv/rooms/${room.code}/events`));

    source.addEventListener('open', () => {
      setLiveConnected(true);
    });

    source.addEventListener('room', (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as TvTransferRoom;
        setRoom(parsed);
        setLiveConnected(true);
      } catch {
        // Ignore malformed frame
      }
    });

    source.addEventListener('error', () => {
      setLiveConnected(false);
    });

    return () => {
      source.close();
      setLiveConnected(false);
    };
  }, [room?.code]);

  const senderUrl =
    typeof window !== 'undefined' && room
      ? `${getPublicAppOrigin()}/?nav=tv-transfer&room=${room.code}`
      : '';

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void joinRoomByCode(joinInput, false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/90">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <Tv className="w-6 h-6 text-blue-400 shrink-0" />
            <span className="text-xl font-bold tracking-tight whitespace-nowrap">
              NetPulse TV Receiver
            </span>
          </div>

          <div className="flex items-center gap-4 text-sm text-slate-300">
            <span>{liveConnected ? 'Live Sync Active' : 'Standby'}</span>
            <button
              type="button"
              onClick={() => onExitTvMode(room?.code)}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-950 bg-slate-100 rounded-md hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              Standard Console
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Pairing Code & QR */}
        <section className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
          <div>
            <h1 className="text-xl font-semibold text-white">Pair Phone or Computer</h1>
            <p className="mt-1.5 text-sm text-slate-300">
              Scan this QR code from your phone or open NetPulse on your computer and enter the
              6-digit pairing code to push APKs and media files directly to this TV.
            </p>
          </div>

          {room ? (
            <div className="space-y-6">
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-5 text-center">
                <div className="text-xs font-medium text-slate-400">TV Pairing Code</div>
                <div className="mt-2 text-5xl font-mono font-bold tracking-[0.2em] text-white tabular-nums">
                  {room.code}
                </div>
                <div className="mt-2 text-xs text-slate-400 font-mono tabular-nums">
                  Expires {new Date(room.expiresAt).toLocaleTimeString()}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-5 bg-slate-950 border border-slate-800 rounded-lg p-5">
                <div className="p-2 bg-white rounded-lg shrink-0">
                  <QrCodeSvg value={senderUrl} size={156} label={`Send files to room ${room.code}`} />
                </div>
                <div className="min-w-0 space-y-2 text-sm">
                  <div className="font-semibold text-white">Scan to Send Files</div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Opens the upload &amp; GitHub APK sender linked straight to room{' '}
                    <span className="font-mono text-white">{room.code}</span>.
                  </p>
                  <div className="text-xs font-mono text-blue-300 break-all">{senderUrl}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-slate-400">
              {loading ? 'Preparing TV pairing code...' : 'No active TV room.'}
            </div>
          )}

          {/* Join existing code or generate new code */}
          <form onSubmit={handleJoinSubmit} className="pt-4 border-t border-slate-800 space-y-3">
            <label htmlFor="tv-join-code" className="block text-xs font-medium text-slate-300">
              Already started a room on your phone? Enter 6-digit code:
            </label>
            <div className="flex items-center gap-2">
              <input
                id="tv-join-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                className="flex-1 h-11 px-3.5 text-base font-mono tracking-widest bg-slate-950 border border-slate-700 rounded-md text-white focus:outline-none focus:ring-4 focus:ring-blue-500/40 focus:border-blue-400"
              />
              <button
                type="submit"
                disabled={loading}
                className="h-11 px-4 text-sm font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 whitespace-nowrap"
              >
                Pair
              </button>
              <button
                type="button"
                onClick={() => void createNewRoom()}
                disabled={loading}
                title="Generate new pairing code"
                className="h-11 px-3.5 text-sm font-medium bg-slate-800 text-slate-100 border border-slate-700 rounded-md hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 whitespace-nowrap"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            {error && <p className="text-xs font-medium text-red-400">{error}</p>}
          </form>

          {(needsServerConfig || isNativeCapacitorOrigin()) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const saved = setSavedApiBaseOverride(serverUrlInput);
                setServerUrlInput(saved);
                void createNewRoom();
              }}
              className="pt-4 border-t border-slate-800 space-y-2.5"
            >
              <label htmlFor="tv-server-url" className="block text-xs font-medium text-slate-300">
                NetPulse Server URL (for APK / LAN / Deployed Cloud Run)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="tv-server-url"
                  type="url"
                  value={serverUrlInput}
                  onChange={(e) => setServerUrlInput(e.target.value)}
                  placeholder="https://your-app.run.app or http://192.168.1.x:3000"
                  className="flex-1 h-10 px-3 text-xs font-mono bg-slate-950 border border-slate-700 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400"
                />
                <button
                  type="submit"
                  className="h-10 px-3.5 text-xs font-semibold bg-slate-800 text-white border border-slate-700 rounded-md hover:bg-slate-700 whitespace-nowrap"
                >
                  Save &amp; Retry
                </button>
              </div>
            </form>
          )}
        </section>

        {/* Right: Incoming Files Queue */}
        <section className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
            <div>
              <h2 className="text-xl font-semibold text-white">Incoming Files &amp; APKs</h2>
              <p className="mt-1 text-sm text-slate-300">
                Select any file with your TV remote to download or install it on your TV.
              </p>
            </div>
            <span className="text-sm font-mono tabular-nums text-slate-300">
              {room?.files.length ?? 0} {room?.files.length === 1 ? 'file' : 'files'}
            </span>
          </div>

          {!room || room.files.length === 0 ? (
            <div className="py-16 border border-dashed border-slate-700 rounded-lg text-center px-6">
              <p className="text-base font-medium text-slate-200">
                Waiting for files from your phone or computer
              </p>
              <p className="mt-2 text-sm text-slate-400 max-w-md mx-auto">
                Files uploaded to code{' '}
                <span className="font-mono text-white">{room?.code || '------'}</span> or queued
                from GitHub Releases will appear here automatically.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {room.files.map((file) => {
                const isApk = /\.(apk|xapk|apks)$/i.test(file.name);
                return (
                  <div
                    key={file.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-slate-950 border border-slate-800 rounded-lg"
                  >
                    <div className="flex items-start gap-3.5 min-w-0">
                      <div className="mt-0.5">
                        <FileIcon name={file.name} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-white break-all">
                          {file.name}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-300 font-mono tabular-nums">
                          <span>{fileCategoryLabel(file)}</span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span>{formatBytes(file.size)}</span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span>
                            {file.source === 'github' && file.sourceDetail
                              ? `GitHub (${file.sourceDetail})`
                              : 'Direct Upload'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <a
                      href={apiUrl(file.downloadUrl)}
                      download={file.name}
                      className={`inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 transition-colors whitespace-nowrap shrink-0 ${
                        isApk
                          ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                          : 'bg-blue-600 text-white hover:bg-blue-500'
                      }`}
                    >
                      <Download className="w-4 h-4" />
                      {isApk ? 'Download & Install APK' : 'Download File'}
                    </a>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
