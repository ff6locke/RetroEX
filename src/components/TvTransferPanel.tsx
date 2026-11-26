import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Github,
  Hammer,
  LogOut,
  Plus,
  RefreshCw,
  Tv,
  Upload,
  Wifi,
} from 'lucide-react';
import type {
  GithubRepoEntry,
  GithubStatusResponse,
  GithubWorkflowRun,
} from '../types/network';
import { QrCodeSvg } from './QrCodeSvg';
import {
  apiUrl,
  getPublicAppOrigin,
  hasReachableBackendConfig,
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

const LAST_REPO_STORAGE_KEY = 'netpulse_last_github_repo_v1';

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

async function readJsonSafe<T = Record<string, unknown>>(
  res: Response,
  endpointLabel: string
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    const hint = titleMatch?.[1]?.trim() || text.replace(/\s+/g, ' ').slice(0, 100);
    throw new Error(
      `${endpointLabel} returned non-JSON response (HTTP ${res.status}): ${hint || 'Empty response'}`
    );
  }
}

export function TvTransferPanel({ initialRoomCode, onOpenTvReceiver }: TvTransferPanelProps) {
  // Zero-server direct P2P file transfer state
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

  // GitHub Actions APK compiler state (only shown when backend is available, hidden in standalone APK)
  const showCloudCompiler = hasReachableBackendConfig();
  const [ghSessionId, setGhSessionId] = useState<string | null>(null);
  const [ghStatus, setGhStatus] = useState<GithubStatusResponse | null>(null);
  const [ghAuthError, setGhAuthError] = useState<string | null>(null);
  const [ghConnecting, setGhConnecting] = useState(false);
  const [ghRepos, setGhRepos] = useState<GithubRepoEntry[]>([]);
  const [ghReposLoading, setGhReposLoading] = useState(false);

  const [ghOwner, setGhOwner] = useState(() => {
    try {
      const saved = localStorage.getItem(LAST_REPO_STORAGE_KEY);
      return saved ? (JSON.parse(saved).owner as string) || '' : '';
    } catch {
      return '';
    }
  });
  const [ghRepo, setGhRepo] = useState(() => {
    try {
      const saved = localStorage.getItem(LAST_REPO_STORAGE_KEY);
      return saved ? (JSON.parse(saved).repo as string) || '' : '';
    } catch {
      return '';
    }
  });
  const [ghBranch, setGhBranch] = useState('main');

  const [compileTag, setCompileTag] = useState('v1.0.0');
  const [compileAppName, setCompileAppName] = useState('NetPulse TV');
  const [compileAppId, setCompileAppId] = useState('app.netpulse.tv');
  const [syncSource, setSyncSource] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileMessage, setCompileMessage] = useState<{ text: string; actionsUrl: string } | null>(null);
  const [workflowRuns, setWorkflowRuns] = useState<GithubWorkflowRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState('netpulse-tv-apk');
  const [newRepoPrivate, setNewRepoPrivate] = useState(false);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [createRepoError, setCreateRepoError] = useState<string | null>(null);

  // Start / restart direct P2P session when roomCode changes
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

  const buildGithubAuthHeaders = useCallback(
    (extra?: Record<string, string>): Record<string, string> => {
      const headers: Record<string, string> = {
        'X-Requested-With': 'NetPulse',
        ...extra,
      };
      if (ghSessionId) {
        headers.Authorization = `Bearer ${ghSessionId}`;
      }
      return headers;
    },
    [ghSessionId]
  );

  const refreshGithubStatusAndRepos = useCallback(
    async (explicitSessionId?: string | null) => {
      if (!hasReachableBackendConfig()) {
        setGhStatus({ ok: true, configured: false });
        setGhAuthError(null);
        setGhRepos([]);
        return;
      }
      const headers: Record<string, string> = { 'X-Requested-With': 'NetPulse' };
      const sid = explicitSessionId !== undefined ? explicitSessionId : ghSessionId;
      if (sid) headers.Authorization = `Bearer ${sid}`;

      try {
        const res = await fetch(apiUrl('/api/github/status'), { cache: 'no-store', headers });
        const statusData = await readJsonSafe<GithubStatusResponse>(res, 'GitHub status');
        setGhStatus(statusData);

        if (statusData.configured && statusData.tokenValid) {
          setGhReposLoading(true);
          try {
            const reposRes = await fetch(apiUrl('/api/github/repos'), { cache: 'no-store', headers });
            const reposData = await readJsonSafe<{ ok: boolean; error?: string; repos?: GithubRepoEntry[] }>(
              reposRes,
              'GitHub repos'
            );
            if (reposRes.ok && reposData.ok && Array.isArray(reposData.repos)) {
              const list = reposData.repos as GithubRepoEntry[];
              setGhRepos(list);
              if (list.length > 0 && !ghOwner && !ghRepo) {
                setGhOwner(list[0].owner);
                setGhRepo(list[0].name);
                setGhBranch(list[0].defaultBranch || 'main');
              }
            } else if (!reposRes.ok) {
              setGhAuthError(reposData.error || `Failed to load repositories (HTTP ${reposRes.status}).`);
            }
          } finally {
            setGhReposLoading(false);
          }
        } else {
          setGhRepos([]);
        }
      } catch (err) {
        setGhStatus({ ok: false, configured: false });
        setGhAuthError(err instanceof Error ? err.message : 'Unable to reach GitHub status API.');
      }
    },
    [ghSessionId, ghOwner, ghRepo]
  );

  useEffect(() => {
    void refreshGithubStatusAndRepos();
  }, [refreshGithubStatusAndRepos]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (
        origin !== window.location.origin &&
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost')
      ) {
        return;
      }
      if (event.data?.type === 'GITHUB_OAUTH_SUCCESS') {
        const sid = typeof event.data.sessionId === 'string' ? event.data.sessionId : null;
        if (sid) setGhSessionId(sid);
        setGhConnecting(false);
        setGhAuthError(null);
        void refreshGithubStatusAndRepos(sid);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [refreshGithubStatusAndRepos]);

  const saveRepoToStorage = (owner: string, repo: string) => {
    try {
      localStorage.setItem(LAST_REPO_STORAGE_KEY, JSON.stringify({ owner, repo }));
    } catch {
      // Ignore storage errors
    }
  };

  const handleConnectGithub = async () => {
    if (!hasReachableBackendConfig()) return;
    setGhConnecting(true);
    setGhAuthError(null);
    try {
      const res = await fetch(apiUrl('/api/auth/github/url'), { cache: 'no-store' });
      const data = await readJsonSafe<{ ok: boolean; url?: string; error?: string }>(
        res,
        'GitHub OAuth URL'
      );
      if (!res.ok || !data.ok || !data.url) {
        setGhAuthError(
          data.error ||
            'GitHub OAuth is not configured on the server yet. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in AI Studio Secrets.'
        );
        setGhConnecting(false);
        return;
      }

      const authWindow = window.open(
        data.url,
        'github_oauth_popup',
        'width=620,height=720'
      );
      if (!authWindow) {
        setGhAuthError('Popup was blocked by your browser. Please allow popups and click Connect GitHub again.');
        setGhConnecting(false);
      }
    } catch (err) {
      setGhAuthError(err instanceof Error ? err.message : 'Unable to start GitHub sign-in.');
      setGhConnecting(false);
    }
  };

  const handleDisconnectGithub = async () => {
    try {
      await fetch(apiUrl('/api/auth/github/logout'), {
        method: 'POST',
        headers: buildGithubAuthHeaders(),
      });
    } catch {
      // Ignore logout network error
    }
    setGhSessionId(null);
    setGhRepos([]);
    setWorkflowRuns([]);
    await refreshGithubStatusAndRepos(null);
  };

  const fetchWorkflowRuns = useCallback(
    async (ownerArg?: string, repoArg?: string, showErrors = false) => {
      const owner = (ownerArg ?? ghOwner).trim();
      const repo = (repoArg ?? ghRepo).trim();
      if (!owner || !repo || !hasReachableBackendConfig()) return;
      setRunsLoading(true);
      if (showErrors) setCompileError(null);
      try {
        const res = await fetch(
          apiUrl(`/api/github/workflow-runs?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`),
          { cache: 'no-store', headers: buildGithubAuthHeaders() }
        );
        const data = await readJsonSafe<{ ok: boolean; error?: string; runs?: GithubWorkflowRun[] }>(
          res,
          'Workflow runs'
        );
        if (res.ok && data.ok) {
          setWorkflowRuns(data.runs || []);
        } else if (showErrors) {
          setCompileError(data.error || `Could not check workflow runs (HTTP ${res.status}).`);
        }
      } catch (err) {
        if (showErrors) {
          setCompileError(err instanceof Error ? err.message : 'Unable to query GitHub Actions runs.');
        }
      } finally {
        setRunsLoading(false);
      }
    },
    [ghOwner, ghRepo, buildGithubAuthHeaders]
  );

  useEffect(() => {
    const hasActiveRun = workflowRuns.some(
      (r) => r.status === 'queued' || r.status === 'in_progress' || r.status === 'waiting'
    );
    if (!hasActiveRun || !ghOwner.trim() || !ghRepo.trim()) return;
    const timer = window.setInterval(() => {
      void fetchWorkflowRuns();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [workflowRuns, ghOwner, ghRepo, fetchWorkflowRuns]);

  const handleCreateRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newRepoName.trim();
    if (!trimmed) {
      setCreateRepoError('Enter a repository name.');
      return;
    }
    setCreatingRepo(true);
    setCreateRepoError(null);
    try {
      const res = await fetch(apiUrl('/api/github/create-repo'), {
        method: 'POST',
        headers: buildGithubAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: trimmed,
          isPrivate: newRepoPrivate,
        }),
      });
      const data = await readJsonSafe<{ ok: boolean; error?: string; repo?: GithubRepoEntry }>(
        res,
        'Create GitHub repo'
      );
      if (!res.ok || !data.ok || !data.repo) {
        setCreateRepoError(data.error || 'Could not create repository.');
        return;
      }
      const created = data.repo as GithubRepoEntry;
      setGhRepos((prev) => [created, ...prev.filter((r) => r.fullName !== created.fullName)]);
      setGhOwner(created.owner);
      setGhRepo(created.name);
      setGhBranch(created.defaultBranch || 'main');
      saveRepoToStorage(created.owner, created.name);
      setShowCreateRepo(false);
    } catch (err) {
      setCreateRepoError(err instanceof Error ? err.message : 'Unable to create repository.');
    } finally {
      setCreatingRepo(false);
    }
  };

  const handleCompileOnGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    const owner = ghOwner.trim();
    const repo = ghRepo.trim();
    if (!owner || !repo) {
      setCompileError('Select or enter a GitHub owner and repository.');
      return;
    }
    saveRepoToStorage(owner, repo);
    setCompiling(true);
    setCompileError(null);
    setCompileMessage(null);

    try {
      const res = await fetch(apiUrl('/api/github/setup-and-compile'), {
        method: 'POST',
        headers: buildGithubAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          owner,
          repo,
          branch: ghBranch.trim() || 'main',
          releaseTag: compileTag.trim() || 'v1.0.0',
          appName: compileAppName.trim() || 'NetPulse TV',
          appId: compileAppId.trim() || 'app.netpulse.tv',
          syncWorkflow: true,
          syncSource,
          serverUrl: '',
        }),
      });
      const data = await readJsonSafe<{
        ok: boolean;
        error?: string;
        message?: string;
        actionsUrl?: string;
      }>(res, 'Compile APK on GitHub');
      if (!res.ok || !data.ok) {
        if (res.status === 401) {
          setGhSessionId(null);
          void refreshGithubStatusAndRepos(null);
        }
        setCompileError(data.error || 'Failed to trigger GitHub Actions APK build.');
        return;
      }
      setCompileMessage({
        text: data.message || 'Started GitHub Actions APK compilation.',
        actionsUrl: data.actionsUrl || `https://github.com/${owner}/${repo}/actions`,
      });
      window.setTimeout(() => {
        void fetchWorkflowRuns(owner, repo);
      }, 1500);
    } catch (err) {
      setCompileError(err instanceof Error ? err.message : 'Unable to start GitHub APK build.');
    } finally {
      setCompiling(false);
    }
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
    <div className="space-y-6">
      {/* Zero-Server Simple Direct File Send */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 text-balance">
              Simple File Send (No Local Server Required)
            </h1>
            <p className="mt-1 text-sm text-slate-600 max-w-3xl">
              Send APKs, videos, subtitles, or any file straight from your phone or computer to
              your Android TV over direct peer-to-peer Wi-Fi—just match the 6-digit code on both
              devices.
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

            {/* Outgoing queue */}
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

            {/* Incoming active transfer */}
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

            {/* Received files list (bidirectional P2P) */}
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

            {/* Join a code already displayed on the TV */}
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

      {/* Optional Web-Only Section: Compile Android TV APK on GitHub Actions */}
      {showCloudCompiler && (
        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b border-slate-200">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-900">
                  Compile Android TV APK on GitHub Actions
                </h2>
                <span className="text-xs font-mono text-slate-500">
                  {ghStatus === null
                    ? 'Checking GitHub status...'
                    : ghStatus.configured && ghStatus.tokenValid
                      ? `Connected as @${ghStatus.username}`
                      : 'Not Connected'}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                Connect your GitHub account to build an Android &amp; TV APK from this app on
                GitHub Actions.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 shrink-0">
              {ghStatus?.configured && ghStatus?.tokenValid ? (
                ghStatus.authSource === 'oauth' && (
                  <button
                    type="button"
                    onClick={() => void handleDisconnectGithub()}
                    className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Disconnect
                  </button>
                )
              ) : (
                <button
                  type="button"
                  onClick={() => void handleConnectGithub()}
                  disabled={ghConnecting}
                  className="inline-flex items-center gap-2 h-9 px-4 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <Github className="w-3.5 h-3.5" />
                  {ghConnecting ? 'Connecting...' : 'Connect GitHub'}
                </button>
              )}
            </div>
          </div>

          {ghAuthError && (
            <div className="p-3.5 border border-amber-200 bg-amber-50/70 rounded-md text-xs text-amber-900 space-y-1.5">
              <div className="font-semibold">{ghAuthError}</div>
              {ghStatus?.callbackUrl && (
                <div className="font-mono text-[11px] text-amber-800 break-all">
                  OAuth Callback URL: {ghStatus.callbackUrl}
                </div>
              )}
            </div>
          )}

          {ghStatus?.configured && ghStatus?.tokenValid && (
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-md">
                <label htmlFor="gh-repo-select" className="text-xs font-medium text-slate-700 whitespace-nowrap">
                  Your GitHub Repository:
                </label>
                <select
                  id="gh-repo-select"
                  value={ghOwner && ghRepo ? `${ghOwner}/${ghRepo}` : ''}
                  onChange={(e) => {
                    const picked = ghRepos.find((r) => r.fullName === e.target.value);
                    if (picked) {
                      setGhOwner(picked.owner);
                      setGhRepo(picked.name);
                      setGhBranch(picked.defaultBranch || 'main');
                      saveRepoToStorage(picked.owner, picked.name);
                    }
                  }}
                  className="flex-1 h-9 px-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                >
                  <option value="">
                    {ghRepos.length > 0
                      ? `Select a repository (${ghRepos.length} loaded)`
                      : 'No repositories found — create one'}
                  </option>
                  {ghRepos.map((r) => (
                    <option key={r.id} value={r.fullName}>
                      {r.fullName} {r.private ? '(Private)' : '(Public)'} · {r.defaultBranch}
                    </option>
                  ))}
                </select>
                {ghReposLoading && (
                  <span className="text-xs text-slate-500 whitespace-nowrap">Refreshing...</span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateRepo((v) => !v);
                    setCreateRepoError(null);
                  }}
                  className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-100 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {showCreateRepo ? 'Cancel' : 'New Repo'}
                </button>
              </div>

              {showCreateRepo && (
                <form
                  onSubmit={handleCreateRepo}
                  className="p-3.5 bg-slate-50 border border-slate-200 rounded-md flex flex-col sm:flex-row sm:items-center gap-3"
                >
                  <input
                    type="text"
                    value={newRepoName}
                    onChange={(e) => setNewRepoName(e.target.value)}
                    placeholder="netpulse-tv-apk"
                    aria-label="New GitHub repository name"
                    className="flex-1 h-9 px-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={newRepoPrivate}
                      onChange={(e) => setNewRepoPrivate(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                    />
                    Private repo
                  </label>
                  <button
                    type="submit"
                    disabled={creatingRepo}
                    className="h-9 px-4 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    {creatingRepo ? 'Creating...' : 'Create Repository'}
                  </button>
                  {createRepoError && (
                    <span className="text-xs font-medium text-red-600">{createRepoError}</span>
                  )}
                </form>
              )}
            </div>
          )}

          <form onSubmit={handleCompileOnGithub} className="grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-4">
              <label htmlFor="comp-owner" className="block text-xs font-medium text-slate-600 mb-1.5">
                GitHub Owner
              </label>
              <input
                id="comp-owner"
                type="text"
                value={ghOwner}
                onChange={(e) => setGhOwner(e.target.value)}
                placeholder="your-github-username"
                className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>

            <div className="md:col-span-5">
              <label htmlFor="comp-repo" className="block text-xs font-medium text-slate-600 mb-1.5">
                Repository Name
              </label>
              <input
                id="comp-repo"
                type="text"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                placeholder="netpulse-tv"
                className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>

            <div className="md:col-span-3">
              <label htmlFor="comp-branch" className="block text-xs font-medium text-slate-600 mb-1.5">
                Branch
              </label>
              <input
                id="comp-branch"
                type="text"
                value={ghBranch}
                onChange={(e) => setGhBranch(e.target.value)}
                placeholder="main"
                className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>

            <div className="md:col-span-4">
              <label htmlFor="comp-tag" className="block text-xs font-medium text-slate-600 mb-1.5">
                Release Tag
              </label>
              <input
                id="comp-tag"
                type="text"
                value={compileTag}
                onChange={(e) => setCompileTag(e.target.value)}
                placeholder="v1.0.0"
                className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>

            <div className="md:col-span-4">
              <label htmlFor="comp-app-name" className="block text-xs font-medium text-slate-600 mb-1.5">
                Android App Name
              </label>
              <input
                id="comp-app-name"
                type="text"
                value={compileAppName}
                onChange={(e) => setCompileAppName(e.target.value)}
                placeholder="NetPulse TV"
                className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>

            <div className="md:col-span-4">
              <label htmlFor="comp-app-id" className="block text-xs font-medium text-slate-600 mb-1.5">
                Package ID
              </label>
              <input
                id="comp-app-id"
                type="text"
                value={compileAppId}
                onChange={(e) => setCompileAppId(e.target.value)}
                placeholder="app.netpulse.tv"
                className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>

            <div className="md:col-span-12 flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  disabled={runsLoading || !ghOwner.trim() || !ghRepo.trim()}
                  onClick={() => void fetchWorkflowRuns(undefined, undefined, true)}
                  className="inline-flex items-center gap-1.5 h-10 px-3.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${runsLoading ? 'animate-spin' : ''}`} />
                  Check Build Status
                </button>
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={syncSource}
                    onChange={(e) => setSyncSource(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                  />
                  Sync NetPulse source &amp; Android TV workflow to repository
                </label>
              </div>

              <button
                type="submit"
                disabled={compiling || !ghStatus?.configured || !ghStatus?.tokenValid}
                className="inline-flex items-center gap-2 h-10 px-5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <Hammer className="w-4 h-4" />
                {compiling ? 'Syncing & Starting Build...' : 'Compile APK on GitHub'}
              </button>
            </div>
          </form>

          {compileError && (
            <div className="p-3.5 border border-red-200 bg-red-50/70 rounded-md text-sm text-red-800">
              {compileError}
            </div>
          )}

          {compileMessage && (
            <div className="p-4 border border-emerald-200 bg-emerald-50/60 rounded-lg flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-medium text-emerald-900">{compileMessage.text}</span>
              <a
                href={compileMessage.actionsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
              >
                Watch Build on GitHub Actions
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}

          {workflowRuns.length > 0 && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs font-semibold text-slate-700">
                <span>Recent GitHub Actions APK Builds</span>
                <span className="font-mono font-normal text-slate-500">
                  {ghOwner}/{ghRepo}
                </span>
              </div>
              <div className="divide-y divide-slate-100">
                {workflowRuns.map((run) => (
                  <div
                    key={run.id}
                    className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-mono font-semibold text-slate-900">
                        Run #{run.runNumber}
                      </span>
                      <span
                        className={
                          run.conclusion === 'success'
                            ? 'font-medium text-emerald-700'
                            : run.conclusion === 'failure'
                              ? 'font-medium text-red-700'
                              : 'font-medium text-blue-700'
                        }
                      >
                        {run.conclusion ? run.conclusion.toUpperCase() : run.status.replace('_', ' ')}
                      </span>
                      <span className="font-mono text-slate-500">
                        · {run.headBranch} · {new Date(run.createdAt).toLocaleString()}
                      </span>
                      {run.failedStep && (
                        <span className="text-red-700 font-mono">
                          ({run.failedStep})
                        </span>
                      )}
                    </div>

                    <a
                      href={run.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline whitespace-nowrap"
                    >
                      View Build &amp; Download APK
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
