import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileUp,
  RefreshCw,
  Tv,
  Upload,
  Wifi,
} from 'lucide-react';
import { QrCodeSvg } from './QrCodeSvg';
import {
  getPublicAppOrigin,
  isAiStudioAuthGatedUrl,
  isNativeCapacitorOrigin,
} from '../utils/apiUrl';
import {
  generateRoomCode,
  P2pTransferSession,
  saveOrShareReceivedFile,
  type P2pConnectionState,
  type P2pIncomingFile,
  type P2pIncomingProgress,
  type P2pOutgoingProgress,
} from '../utils/p2pTransfer';

interface TvTransferPanelProps {
  initialRoomCode?: string;
  onOpenTvReceiver: (code?: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function classifyTransferFile(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.apk') || lower.endsWith('.xapk') || lower.endsWith('.apks')) {
    return 'Android APK';
  }
  if (/\.(mp4|mkv|mov|avi|webm)$/i.test(lower)) return 'Video';
  if (/\.(mp3|flac|aac|wav)$/i.test(lower)) return 'Audio';
  if (/\.(srt|vtt|ass)$/i.test(lower)) return 'Subtitles';
  if (/\.(zip|tar|gz)$/i.test(lower)) return 'Archive';
  if (/\.(png|jpg|jpeg|webp)$/i.test(lower)) return 'Image';
  return 'File';
}

export function TvTransferPanel({ initialRoomCode, onOpenTvReceiver }: TvTransferPanelProps) {
  const [roomCode, setRoomCode] = useState<string>(() =>
    initialRoomCode && /^\d{6}$/.test(initialRoomCode) ? initialRoomCode : generateRoomCode()
  );
  const [joinCodeInput, setJoinCodeInput] = useState(() =>
    initialRoomCode && /^\d{6}$/.test(initialRoomCode) ? initialRoomCode : ''
  );
  const [joinError, setJoinError] = useState<string | null>(null);
  const [connState, setConnState] = useState<P2pConnectionState>('initializing');
  const [connDetail, setConnDetail] = useState<string>('Connecting direct pairing...');
  const [outgoingFiles, setOutgoingFiles] = useState<P2pOutgoingProgress[]>([]);
  const [incomingProgress, setIncomingProgress] = useState<P2pIncomingProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<P2pIncomingFile[]>([]);

  const sessionRef = useRef<P2pTransferSession | null>(null);
  const receivedFilesRef = useRef<P2pIncomingFile[]>([]);
  receivedFilesRef.current = receivedFiles;

  const [isDragging, setIsDragging] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setOutgoingFiles([]);
    setIncomingProgress(null);

    const session = new P2pTransferSession(roomCode, {
      onStateChange: (state, detail) => {
        setConnState(state);
        if (detail) setConnDetail(detail);
      },
      onOutgoingUpdate: (items) => {
        setOutgoingFiles(items);
      },
      onIncomingProgress: (progress) => {
        setIncomingProgress(progress);
      },
      onFileReceived: (file) => {
        setReceivedFiles((prev) => [file, ...prev]);
      },
    });
    sessionRef.current = session;

    return () => {
      session.destroy();
      if (sessionRef.current === session) {
        sessionRef.current = null;
      }
    };
  }, [roomCode]);

  useEffect(() => {
    return () => {
      for (const f of receivedFilesRef.current) {
        URL.revokeObjectURL(f.blobUrl);
      }
    };
  }, []);

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1800);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  const handleQueueFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    sessionRef.current?.queueFiles(list);
  };

  const handleJoinCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = joinCodeInput.replace(/\D/g, '').slice(0, 6);
    if (clean.length !== 6) {
      setJoinError('Enter a valid 6-digit pairing code.');
      return;
    }
    setJoinError(null);
    setRoomCode(clean);
  };

  const handleNewCode = () => {
    setJoinError(null);
    const next = generateRoomCode();
    setRoomCode(next);
    setJoinCodeInput('');
  };

  const publicOrigin = getPublicAppOrigin();
  const canShowWebQr =
    !isNativeCapacitorOrigin() &&
    Boolean(publicOrigin) &&
    !isAiStudioAuthGatedUrl(publicOrigin);
  const tvReceiverUrl = canShowWebQr ? `${publicOrigin}/?tv=${roomCode}` : '';

  const incomingPct =
    incomingProgress && incomingProgress.size > 0
      ? Math.min(100, Math.round((incomingProgress.receivedBytes / incomingProgress.size) * 100))
      : 0;

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 text-balance">
            Simple File Send (No Local Server Required)
          </h1>
          <p className="mt-1 text-sm text-slate-600 max-w-3xl">
            Send APKs, videos, subtitles, or any file straight from your phone or computer to your
            Android TV over direct peer-to-peer Wi-Fi—just match the 6-digit code on both devices.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleNewCode}
            className="inline-flex items-center gap-1.5 h-10 px-3.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            New Code
          </button>
          <button
            type="button"
            onClick={() => onOpenTvReceiver(roomCode)}
            className="inline-flex items-center gap-2 h-10 px-4 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
          >
            <Tv className="w-4 h-4" />
            Open TV Receiver Screen
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 7 cols: Dropzone + Outgoing & Received Files */}
        <div className="lg:col-span-7 space-y-5">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files?.length) {
                handleQueueFiles(e.dataTransfer.files);
              }
            }}
            className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
              isDragging
                ? 'border-blue-600 bg-blue-50/60'
                : 'border-slate-300 bg-slate-50/50 hover:border-slate-400'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  handleQueueFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <Upload className="w-7 h-7 text-slate-500 mx-auto" />
            <div className="mt-3 text-sm font-semibold text-slate-900">
              Drop files or Android APKs here to send
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Streams directly device-to-device (no file size server cap). You can pick files now
              and they will send automatically as soon as both devices pair.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                <FileUp className="w-4 h-4" />
                Choose Files
              </button>
            </div>
          </div>

          {outgoingFiles.length > 0 && (
            <div>
              <div className="flex items-center justify-between pb-2.5 border-b border-slate-200">
                <h2 className="text-sm font-semibold text-slate-900">Outgoing Transfers</h2>
                <button
                  type="button"
                  onClick={() => sessionRef.current?.clearCompletedOutgoing()}
                  className="text-xs font-medium text-slate-500 hover:text-slate-800"
                >
                  Clear finished
                </button>
              </div>
              <div className="divide-y divide-slate-100">
                {outgoingFiles.map((item) => {
                  const pct =
                    item.size > 0
                      ? Math.min(100, Math.round((item.sentBytes / item.size) * 100))
                      : item.status === 'sent'
                        ? 100
                        : 0;
                  return (
                    <div key={item.id} className="py-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <span className="font-medium text-slate-900 break-all">{item.name}</span>
                          <span className="ml-2 font-mono tabular-nums text-slate-500">
                            {formatBytes(item.size)} · {classifyTransferFile(item.name)}
                          </span>
                        </div>
                        <span
                          className={`font-mono font-medium shrink-0 ${
                            item.status === 'sent'
                              ? 'text-emerald-700'
                              : item.status === 'error'
                                ? 'text-red-700'
                                : item.status === 'sending'
                                  ? 'text-blue-700'
                                  : 'text-slate-500'
                          }`}
                        >
                          {item.status === 'sent'
                            ? 'Delivered'
                            : item.status === 'error'
                              ? item.error || 'Failed'
                              : item.status === 'sending'
                                ? `Sending ${pct}%`
                                : connState === 'connected'
                                  ? 'Queued'
                                  : 'Waiting for pair'}
                        </span>
                      </div>
                      {(item.status === 'sending' || item.status === 'sent') && (
                        <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all ${
                              item.status === 'sent' ? 'bg-emerald-600' : 'bg-blue-600'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {incomingProgress && (
            <div className="p-3.5 border border-blue-200 bg-blue-50/50 rounded-md space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-slate-900 truncate">
                  Receiving {incomingProgress.name}...
                </span>
                <span className="font-mono tabular-nums text-blue-700">{incomingPct}%</span>
              </div>
              <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all"
                  style={{ width: `${incomingPct}%` }}
                />
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Received Files</h2>
                <p className="text-xs text-slate-500">
                  Files sent to code <span className="font-mono text-slate-800">{roomCode}</span>{' '}
                  appear here ready to save or install.
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {receivedFiles.length} {receivedFiles.length === 1 ? 'file' : 'files'}
              </span>
            </div>

            {receivedFiles.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500 border-b border-slate-100">
                No incoming files yet. Send a file from the paired device to save it here.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                      <th className="py-2 pr-3">File</th>
                      <th className="py-2 px-3">Type</th>
                      <th className="py-2 px-3 text-right">Size</th>
                      <th className="py-2 pl-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {receivedFiles.map((file) => (
                      <tr key={file.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 pr-3">
                          <div className="font-medium text-slate-900 break-all">{file.name}</div>
                        </td>
                        <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                          {classifyTransferFile(file.name)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {formatBytes(file.size)}
                        </td>
                        <td className="py-2.5 pl-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => void saveOrShareReceivedFile(file)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Save
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right 5 cols: 6-digit Pairing Code & Join */}
        <div className="lg:col-span-5 border border-slate-200 rounded-lg p-5 space-y-5 bg-slate-50/40">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-medium text-slate-500">6-Digit Pairing Code</div>
              <div className="mt-1 text-3xl font-mono font-bold tracking-[0.18em] text-slate-900 tabular-nums">
                {roomCode}
              </div>
              <div className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-slate-700">
                <Wifi
                  className={`w-3.5 h-3.5 ${
                    connState === 'connected'
                      ? 'text-emerald-600'
                      : connState === 'error'
                        ? 'text-red-600'
                        : 'text-blue-600'
                  }`}
                />
                <span>{connDetail}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void copyText('room-code', roomCode)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 whitespace-nowrap"
            >
              {copiedKey === 'room-code' ? (
                <Check className="w-3.5 h-3.5 text-emerald-700" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copiedKey === 'room-code' ? 'Copied' : 'Copy Code'}
            </button>
          </div>

          {canShowWebQr && tvReceiverUrl && (
            <div className="flex flex-col sm:flex-row items-center gap-4 pt-4 border-t border-slate-200">
              <QrCodeSvg
                value={tvReceiverUrl}
                size={136}
                label={`Open TV receiver for code ${roomCode}`}
              />
              <div className="min-w-0 space-y-2">
                <div className="text-xs font-semibold text-slate-900">
                  Open on Your Smart TV Browser
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Or open the NetPulse TV app and enter code{' '}
                  <span className="font-mono font-semibold text-slate-900">{roomCode}</span>.
                </p>
                <button
                  type="button"
                  onClick={() => void copyText('tv-url', tvReceiverUrl)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline"
                >
                  {copiedKey === 'tv-url' ? 'Copied TV receiver link' : 'Copy TV receiver link'}
                </button>
              </div>
            </div>
          )}

          <form onSubmit={handleJoinCodeSubmit} className="pt-4 border-t border-slate-200 space-y-2">
            <label htmlFor="join-tv-code" className="block text-xs font-medium text-slate-600">
              Have a 6-digit code shown on your TV or other device? Enter it here:
            </label>
            <div className="flex items-center gap-2">
              <input
                id="join-tv-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                className="flex-1 h-9 px-3 text-sm font-mono tracking-widest bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
              <button
                type="submit"
                className="h-9 px-3.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
              >
                Pair
              </button>
            </div>
            {joinError && <p className="text-xs text-red-600">{joinError}</p>}
          </form>
        </div>
      </div>
    </section>
  );
}
