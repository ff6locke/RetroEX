import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FileBox, Film, Package, RefreshCw, Tv, Wifi } from 'lucide-react';
import { QrCodeSvg } from './QrCodeSvg';
import { getPublicAppOrigin, isAiStudioAuthGatedUrl, isNativeCapacitorOrigin } from '../utils/apiUrl';
import {
  generateRoomCode,
  P2pTransferSession,
  saveOrShareReceivedFile,
  type P2pConnectionState,
  type P2pIncomingFile,
  type P2pIncomingProgress,
} from '../utils/p2pTransfer';

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

function fileCategoryLabel(name: string): string {
  const lower = name.toLowerCase();
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
  const [roomCode, setRoomCode] = useState<string>(() =>
    initialCode && /^\d{6}$/.test(initialCode) ? initialCode : generateRoomCode()
  );
  const [joinInput, setJoinInput] = useState(() =>
    initialCode && /^\d{6}$/.test(initialCode) ? initialCode : ''
  );
  const [connState, setConnState] = useState<P2pConnectionState>('initializing');
  const [connDetail, setConnDetail] = useState<string>('Starting direct pairing...');
  const [incomingProgress, setIncomingProgress] = useState<P2pIncomingProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<P2pIncomingFile[]>([]);
  const [joinError, setJoinError] = useState<string | null>(null);

  const receivedFilesRef = useRef<P2pIncomingFile[]>([]);
  receivedFilesRef.current = receivedFiles;

  useEffect(() => {
    const session = new P2pTransferSession(roomCode, {
      onStateChange: (state, detail) => {
        setConnState(state);
        if (detail) setConnDetail(detail);
      },
      onOutgoingUpdate: () => {
        // Receiver view focuses on incoming files
      },
      onIncomingProgress: (progress) => {
        setIncomingProgress(progress);
      },
      onFileReceived: (file) => {
        setReceivedFiles((prev) => [file, ...prev]);
      },
    });

    return () => {
      session.destroy();
    };
  }, [roomCode]);

  useEffect(() => {
    return () => {
      for (const f of receivedFilesRef.current) {
        URL.revokeObjectURL(f.blobUrl);
      }
    };
  }, []);

  const handleNewCode = useCallback(() => {
    setJoinError(null);
    const next = generateRoomCode();
    setRoomCode(next);
    setJoinInput('');
  }, []);

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = joinInput.replace(/\D/g, '').slice(0, 6);
    if (clean.length !== 6) {
      setJoinError('Enter a valid 6-digit pairing code.');
      return;
    }
    setJoinError(null);
    setRoomCode(clean);
  };

  const publicOrigin = getPublicAppOrigin();
  const canShowWebQr =
    !isNativeCapacitorOrigin() &&
    Boolean(publicOrigin) &&
    !isAiStudioAuthGatedUrl(publicOrigin);
  const senderUrl = canShowWebQr ? `${publicOrigin}/?nav=tv-transfer&room=${roomCode}` : '';

  const incomingPct =
    incomingProgress && incomingProgress.size > 0
      ? Math.min(100, Math.round((incomingProgress.receivedBytes / incomingProgress.size) * 100))
      : 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/90">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <Tv className="w-6 h-6 text-blue-400 shrink-0" />
            <span className="text-xl font-bold tracking-tight whitespace-nowrap">
              NetPulse Direct Receiver
            </span>
          </div>

          <div className="flex items-center gap-4 text-sm text-slate-300">
            <span className="inline-flex items-center gap-2">
              <Wifi
                className={`w-4 h-4 ${
                  connState === 'connected'
                    ? 'text-emerald-400'
                    : connState === 'error'
                      ? 'text-red-400'
                      : 'text-blue-400'
                }`}
              />
              {connState === 'connected'
                ? 'Direct P2P Connected'
                : connState === 'pairing'
                  ? 'Pairing...'
                  : 'Ready (No Server Needed)'}
            </span>
            <button
              type="button"
              onClick={() => onExitTvMode(roomCode)}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-950 bg-slate-100 rounded-md hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              Standard Console
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Pairing Code */}
        <section className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
          <div>
            <h1 className="text-xl font-semibold text-white">Pair Phone or Computer</h1>
            <p className="mt-1.5 text-sm text-slate-300">
              Open NetPulse on your phone or computer under <strong>File Send</strong> and enter
              this 6-digit code. Files transfer directly device-to-device with no local server.
            </p>
          </div>

          <div className="space-y-4">
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-6 text-center">
              <div className="text-xs font-medium text-slate-400">6-Digit Pairing Code</div>
              <div className="mt-2 text-5xl font-mono font-bold tracking-[0.2em] text-white tabular-nums">
                {roomCode}
              </div>
              <div className="mt-3 text-xs text-slate-300">{connDetail}</div>
            </div>

            {canShowWebQr && senderUrl && (
              <div className="flex flex-col sm:flex-row items-center gap-5 bg-slate-950 border border-slate-800 rounded-lg p-5">
                <div className="p-2 bg-white rounded-lg shrink-0">
                  <QrCodeSvg value={senderUrl} size={140} label={`Send files to code ${roomCode}`} />
                </div>
                <div className="min-w-0 space-y-2 text-sm">
                  <div className="font-semibold text-white">Scan to Send Files</div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Opens NetPulse File Send linked directly to code{' '}
                    <span className="font-mono text-white">{roomCode}</span>.
                  </p>
                  <div className="text-xs font-mono text-blue-300 break-all">{senderUrl}</div>
                </div>
              </div>
            )}
          </div>

          {/* Join existing code or generate new code */}
          <form onSubmit={handleJoinSubmit} className="pt-4 border-t border-slate-800 space-y-3">
            <label htmlFor="tv-join-code" className="block text-xs font-medium text-slate-300">
              Already started on your phone? Enter its 6-digit code:
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
                className="h-11 px-4 text-sm font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 whitespace-nowrap"
              >
                Pair
              </button>
              <button
                type="button"
                onClick={handleNewCode}
                title="Generate new pairing code"
                className="h-11 px-3.5 text-sm font-medium bg-slate-800 text-slate-100 border border-slate-700 rounded-md hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 whitespace-nowrap"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            {joinError && <p className="text-xs font-medium text-red-400">{joinError}</p>}
          </form>
        </section>

        {/* Right: Incoming Files Queue */}
        <section className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
            <div>
              <h2 className="text-xl font-semibold text-white">Received Files &amp; APKs</h2>
              <p className="mt-1 text-sm text-slate-300">
                Select any received file with your TV remote to save or install it on your TV.
              </p>
            </div>
            <span className="text-sm font-mono tabular-nums text-slate-300">
              {receivedFiles.length} {receivedFiles.length === 1 ? 'file' : 'files'}
            </span>
          </div>

          {incomingProgress && (
            <div className="p-4 bg-slate-950 border border-blue-500/40 rounded-lg space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-white truncate">
                  Receiving {incomingProgress.name}...
                </span>
                <span className="font-mono tabular-nums text-blue-300 shrink-0">
                  {incomingPct}%
                </span>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${incomingPct}%` }}
                />
              </div>
              <div className="text-xs font-mono tabular-nums text-slate-400">
                {formatBytes(incomingProgress.receivedBytes)} / {formatBytes(incomingProgress.size)}
              </div>
            </div>
          )}

          {receivedFiles.length === 0 ? (
            <div className="py-16 border border-dashed border-slate-700 rounded-lg text-center px-6">
              <p className="text-base font-medium text-slate-200">
                Waiting for files from your phone or computer
              </p>
              <p className="mt-2 text-sm text-slate-400 max-w-md mx-auto">
                Enter code <span className="font-mono text-white">{roomCode}</span> on the sending
                device and drop any file or APK—it streams straight here over P2P.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {receivedFiles.map((file) => {
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
                          <span>{fileCategoryLabel(file.name)}</span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span>{formatBytes(file.size)}</span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span>Direct P2P</span>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void saveOrShareReceivedFile(file)}
                      className={`inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 transition-colors whitespace-nowrap shrink-0 ${
                        isApk
                          ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                          : 'bg-blue-600 text-white hover:bg-blue-500'
                      }`}
                    >
                      <Download className="w-4 h-4" />
                      {isApk ? 'Save / Install APK' : 'Save File'}
                    </button>
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
