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
  Package,
  Plus,
  RefreshCw,
  Terminal,
  Tv,
  Upload,
  Wifi,
} from 'lucide-react';
import type {
  GithubReleaseEntry,
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

  // GitHub state (session ID kept strictly in React memory, never localStorage)
  const [ghSessionId, setGhSessionId] = useState<string | null>(null);
  const [ghTab, setGhTab] = useState<'compile' | 'browse' | 'publish'>(() =>
    hasReachableBackendConfig() ? 'compile' : 'browse'
  );
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

  // Compile on GitHub Actions state
  const [compileTag, setCompileTag] = useState('v1.0.0');
  const [compileAppName, setCompileAppName] = useState('NetPulse TV');
  const [compileAppId, setCompileAppId] = useState('app.netpulse.tv');
  const [compileServerUrl, setCompileServerUrl] = useState(() => {
    const origin = getPublicAppOrigin();
    return isAiStudioAuthGatedUrl(origin) ? '' : origin;
  });
  const [syncSource, setSyncSource] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileMessage, setCompileMessage] = useState<{ text: string; actionsUrl: string } | null>(null);
  const [workflowRuns, setWorkflowRuns] = useState<GithubWorkflowRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  // Create GitHub repository inline state
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState('netpulse-tv-apk');
  const [newRepoPrivate, setNewRepoPrivate] = useState(false);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [createRepoError, setCreateRepoError] = useState<string | null>(null);

  // Browse releases state
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [releases, setReleases] = useState<GithubReleaseEntry[]>([]);

  // Publish APK to GitHub state
  const [pubTag, setPubTag] = useState('v1.0.0');
  const [pubTitle, setPubTitle] = useState('NetPulse TV v1.0.0');
  const [pubNotes, setPubNotes] = useState('Android & TV APK release.');
  const [pubPrerelease, setPubPrerelease] = useState(false);
  const [pubFile, setPubFile] = useState<File | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{
    releaseUrl: string;
    tagName: string;
    assetName: string;
    assetSize: number;
    downloadUrl: string;
  } | null>(null);

  // Local ADB sideload helper
  const [tvLanIp, setTvLanIp] = useState('192.168.1.45');
  const [adbFilename, setAdbFilename] = useState('app-release.apk');

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
    const apk = list.find((f) => /\.(apk|xapk|apks)$/i.test(f.name));
    if (apk) {
      setAdbFilename(apk.name);
    }
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

  // Listen for OAuth popup completion via cross-origin/same-origin postMessage
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
    if (!hasReachableBackendConfig()) {
      setGhAuthError(
        'GitHub OAuth & Actions compilation runs from the NetPulse web app. Inside this standalone APK, use the Release APKs tab directly.'
      );
      return;
    }
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

  // Auto-poll GitHub Actions runs while a build is queued or running
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
          serverUrl: compileServerUrl.trim(),
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

  const loadReleasesForRepo = useCallback(
    async (ownerArg?: string, repoArg?: string) => {
      const owner = (ownerArg ?? ghOwner).trim();
      const repo = (repoArg ?? ghRepo).trim();
      if (!owner || !repo) {
        setReleasesError('Enter both GitHub owner and repository name.');
        return;
      }
      saveRepoToStorage(owner, repo);
      setReleasesLoading(true);
      setReleasesError(null);
      setReleases([]);

      const fetchPublicGithubReleases = async () => {
        const publicRes = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=15`,
          { headers: { Accept: 'application/vnd.github+json' } }
        );
        if (!publicRes.ok) {
          throw new Error(`GitHub returned HTTP ${publicRes.status} for ${owner}/${repo}.`);
        }
        const raw = (await publicRes.json()) as Array<{
          id: number;
          tag_name: string;
          name: string | null;
          prerelease: boolean;
          draft: boolean;
          published_at: string | null;
          html_url: string;
          assets: Array<{
            id: number;
            name: string;
            size: number;
            content_type: string;
            download_count: number;
            browser_download_url: string;
          }>;
        }>;
        setReleases(
          raw.map((r) => ({
            id: r.id,
            tagName: r.tag_name,
            name: r.name || r.tag_name,
            prerelease: r.prerelease,
            draft: r.draft,
            publishedAt: r.published_at,
            htmlUrl: r.html_url,
            assets: (r.assets || []).map((a) => ({
              id: a.id,
              name: a.name,
              size: a.size,
              contentType: a.content_type,
              downloadCount: a.download_count,
              browserDownloadUrl: a.browser_download_url,
              isApk: /\.(apk|xapk|apks)$/i.test(a.name),
            })),
          }))
        );
      };

      try {
        if (!hasReachableBackendConfig()) {
          await fetchPublicGithubReleases();
          return;
        }

        const res = await fetch(
          apiUrl(`/api/github/releases?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`),
          { cache: 'no-store', headers: buildGithubAuthHeaders() }
        );
        const data = await readJsonSafe<{
          ok: boolean;
          error?: string;
          releases?: GithubReleaseEntry[];
        }>(res, 'Load GitHub releases');
        if (!res.ok || !data.ok) {
          setReleasesError(data.error || 'Failed to fetch GitHub releases.');
          return;
        }
        setReleases(data.releases || []);
      } catch (err) {
        try {
          await fetchPublicGithubReleases();
          return;
        } catch {
          // Surface original error below
        }
        setReleasesError(err instanceof Error ? err.message : 'GitHub lookup failed.');
      } finally {
        setReleasesLoading(false);
      }
    },
    [ghOwner, ghRepo, buildGithubAuthHeaders]
  );

  const handleFetchReleases = async (e: React.FormEvent) => {
    e.preventDefault();
    await loadReleasesForRepo();
  };

  const handlePublishApk = async (e: React.FormEvent) => {
    e.preventDefault();
    const owner = ghOwner.trim();
    const repo = ghRepo.trim();
    if (!owner || !repo) {
      setPublishError('Enter target GitHub owner and repository name.');
      return;
    }
    if (!pubTag.trim()) {
      setPublishError('Enter a release tag (e.g. v1.0.0).');
      return;
    }
    if (!pubFile) {
      setPublishError('Select an .apk file from your device to publish.');
      return;
    }

    saveRepoToStorage(owner, repo);
    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);

    try {
      const formData = new FormData();
      formData.append('owner', owner);
      formData.append('repo', repo);
      formData.append('tagName', pubTag.trim());
      formData.append('releaseName', pubTitle.trim() || pubTag.trim());
      formData.append('notes', pubNotes.trim());
      formData.append('prerelease', String(pubPrerelease));
      formData.append('apk', pubFile);

      const res = await fetch(apiUrl('/api/github/publish-apk'), {
        method: 'POST',
        headers: buildGithubAuthHeaders(),
        body: formData,
      });
      const data = await readJsonSafe<{
        ok: boolean;
        error?: string;
        releaseUrl?: string;
        tagName?: string;
        asset?: { name: string; size: number; downloadUrl: string };
      }>(res, 'Publish APK release');
      if (!res.ok || !data.ok || !data.asset) {
        setPublishError(data.error || 'Failed to publish APK release.');
        return;
      }
      setPublishResult({
        releaseUrl: data.releaseUrl || '',
        tagName: data.tagName || pubTag.trim(),
        assetName: data.asset.name,
        assetSize: data.asset.size,
        downloadUrl: data.asset.downloadUrl,
      });
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Network error publishing APK.');
    } finally {
      setPublishing(false);
    }
  };

  const publicOrigin = getPublicAppOrigin();
  const canShowWebQr =
    !isNativeCapacitorOrigin() &&
    Boolean(publicOrigin) &&
    !isAiStudioAuthGatedUrl(publicOrigin);
  const tvReceiverUrl = canShowWebQr ? `${publicOrigin}/?tv=${roomCode}` : '';

  const cleanTvIp = tvLanIp.trim() || '192.168.1.45';
  const cleanAdbFile = adbFilename.trim() || 'app-release.apk';
  const adbConnectCmd = `adb connect ${cleanTvIp}:5555`;
  const adbInstallCmd = `adb -s ${cleanTvIp}:5555 install -r "${cleanAdbFile}"`;
  const adbPushCmd = `adb -s ${cleanTvIp}:5555 push "${cleanAdbFile}" /sdcard/Download/`;

  const incomingPct =
    incomingProgress && incomingProgress.size > 0
      ? Math.min(100, Math.round((incomingProgress.receivedBytes / incomingProgress.size) * 100))
      : 0;

  return (
    <div className="space-y-6">
      {/* Section 1: Zero-Server Simple Direct File Send */}
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

      {/* Section 2: GitHub OAuth, Cloud APK Compiler & Releases */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                GitHub APK Releases &amp; Cloud Builder
              </h2>
              {hasReachableBackendConfig() && (
                <span className="text-xs font-mono text-slate-500">
                  {ghStatus === null
                    ? 'Checking GitHub status...'
                    : ghStatus.configured && ghStatus.tokenValid
                      ? `Connected as @${ghStatus.username}`
                      : 'Not Connected'}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Download public APK releases straight from GitHub on any device, or connect GitHub in
              the web app to compile and publish APKs via GitHub Actions.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {hasReachableBackendConfig() &&
              (ghStatus?.configured && ghStatus?.tokenValid ? (
                <div className="flex items-center gap-2">
                  {ghStatus.authSource === 'oauth' && (
                    <button
                      type="button"
                      onClick={() => void handleDisconnectGithub()}
                      className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Disconnect
                    </button>
                  )}
                </div>
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
              ))}

            <div
              className="inline-flex items-center p-1 bg-slate-100 rounded-lg shrink-0"
              role="tablist"
              aria-label="GitHub APK mode"
            >
              <button
                type="button"
                role="tab"
                aria-selected={ghTab === 'browse'}
                onClick={() => setGhTab('browse')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  ghTab === 'browse'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Release APKs
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={ghTab === 'compile'}
                onClick={() => setGhTab('compile')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  ghTab === 'compile'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Compile on GitHub
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={ghTab === 'publish'}
                onClick={() => setGhTab('publish')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  ghTab === 'publish'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Upload APK
              </button>
            </div>
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

        {/* Repository selector & New Repo creator when connected */}
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

        {ghTab === 'compile' ? (
          <div className="space-y-5">
            {(!ghStatus?.configured || !ghStatus?.tokenValid) && (
              <div className="p-4 border border-slate-200 bg-slate-50 rounded-lg space-y-2 text-xs text-slate-700">
                <div className="font-semibold text-slate-900">
                  Compile APKs Directly on GitHub Actions
                </div>
                <p className="leading-relaxed">
                  {hasReachableBackendConfig() ? (
                    <>
                      Click <strong>Connect GitHub</strong> above to sign in with GitHub OAuth.
                      Once connected, NetPulse syncs{' '}
                      <span className="font-mono">.github/workflows/publish-apk.yml</span> and
                      dispatches the Android Gradle + Capacitor APK build on GitHub&apos;s runners.
                    </>
                  ) : (
                    <>
                      Compiling a new APK requires signing into GitHub from the NetPulse web app.
                      To download already-built APKs straight to this device, open the{' '}
                      <strong>Release APKs</strong> tab.
                    </>
                  )}
                </p>
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

              <div className="md:col-span-12">
                <label htmlFor="comp-server-url" className="block text-xs font-medium text-slate-600 mb-1.5">
                  Optional Cloud Server URL (leave blank — Simple File Send works without a server)
                </label>
                <input
                  id="comp-server-url"
                  type="url"
                  value={compileServerUrl}
                  onChange={(e) => setCompileServerUrl(e.target.value)}
                  placeholder="Leave blank for standalone zero-server APK"
                  className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>

              <div className="md:col-span-12 flex flex-wrap items-center justify-between gap-3 pt-1">
                <div className="flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    disabled={runsLoading || !ghOwner.trim() || !ghRepo.trim() || !hasReachableBackendConfig()}
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

                      <div className="flex items-center gap-2.5">
                        {run.conclusion === 'success' && (
                          <button
                            type="button"
                            onClick={() => {
                              setGhTab('browse');
                              void loadReleasesForRepo();
                            }}
                            className="px-2.5 py-1 font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 whitespace-nowrap"
                          >
                            View Release APK
                          </button>
                        )}
                        <a
                          href={run.htmlUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline whitespace-nowrap"
                        >
                          Logs
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : ghTab === 'browse' ? (
          <div className="space-y-5">
            <form onSubmit={handleFetchReleases} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
              <div className="md:col-span-4">
                <label htmlFor="gh-owner" className="block text-xs font-medium text-slate-600 mb-1.5">
                  GitHub Owner / Organization
                </label>
                <input
                  id="gh-owner"
                  type="text"
                  value={ghOwner}
                  onChange={(e) => setGhOwner(e.target.value)}
                  placeholder="e.g. ff6locke"
                  className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>
              <div className="md:col-span-5">
                <label htmlFor="gh-repo" className="block text-xs font-medium text-slate-600 mb-1.5">
                  Repository Name
                </label>
                <input
                  id="gh-repo"
                  type="text"
                  value={ghRepo}
                  onChange={(e) => setGhRepo(e.target.value)}
                  placeholder="e.g. Netpulse-tv-transfer"
                  className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>
              <div className="md:col-span-3">
                <button
                  type="submit"
                  disabled={releasesLoading}
                  className="w-full h-10 px-4 inline-flex items-center justify-center gap-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <RefreshCw className={`w-4 h-4 ${releasesLoading ? 'animate-spin' : ''}`} />
                  {releasesLoading ? 'Loading Releases...' : 'Load Releases'}
                </button>
              </div>
            </form>

            {releasesError && (
              <div className="p-3.5 border border-red-200 bg-red-50/70 rounded-md text-sm text-red-800">
                {releasesError}
              </div>
            )}

            {releases.length === 0 && !releasesLoading && !releasesError && (
              <div className="py-8 border border-dashed border-slate-200 rounded-lg text-center px-4">
                <p className="text-sm font-medium text-slate-700">
                  Enter any public GitHub repository to load its APK releases
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Works directly on phone, computer, or TV with no local server required.
                </p>
              </div>
            )}

            {releases.length > 0 && (
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                {releases.map((rel) => (
                  <div key={rel.id} className="p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="text-sm font-semibold text-slate-900">{rel.name}</span>
                        <span className="text-xs font-mono text-slate-500">{rel.tagName}</span>
                        {rel.prerelease && (
                          <span className="text-xs font-medium text-amber-700">Pre-release</span>
                        )}
                        {rel.publishedAt && (
                          <span className="text-xs text-slate-500 font-mono tabular-nums">
                            · {new Date(rel.publishedAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <a
                        href={rel.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
                      >
                        View on GitHub
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>

                    {rel.assets.length === 0 ? (
                      <p className="text-xs text-slate-500">No attached binary assets on this release.</p>
                    ) : (
                      <div className="divide-y divide-slate-100 border border-slate-100 rounded-md bg-slate-50/50">
                        {rel.assets.map((asset) => (
                          <div
                            key={asset.id}
                            className="px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Package
                                className={`w-4 h-4 shrink-0 ${
                                  asset.isApk ? 'text-emerald-700' : 'text-slate-400'
                                }`}
                              />
                              <span className="font-mono font-medium text-slate-900 break-all">
                                {asset.name}
                              </span>
                              <span className="text-slate-500 font-mono tabular-nums whitespace-nowrap">
                                · {formatBytes(asset.size)} · {asset.downloadCount} downloads
                              </span>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <a
                                href={asset.browserDownloadUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium text-white bg-blue-600 rounded hover:bg-blue-700 whitespace-nowrap"
                              >
                                <Download className="w-3 h-3" />
                                Download APK
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <form onSubmit={handlePublishApk} className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div className="md:col-span-4">
                <label htmlFor="pub-owner" className="block text-xs font-medium text-slate-600 mb-1.5">
                  GitHub Owner
                </label>
                <input
                  id="pub-owner"
                  type="text"
                  value={ghOwner}
                  onChange={(e) => setGhOwner(e.target.value)}
                  placeholder="your-github-username"
                  className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>

              <div className="md:col-span-4">
                <label htmlFor="pub-repo" className="block text-xs font-medium text-slate-600 mb-1.5">
                  Repository Name
                </label>
                <input
                  id="pub-repo"
                  type="text"
                  value={ghRepo}
                  onChange={(e) => setGhRepo(e.target.value)}
                  placeholder="netpulse-tv"
                  className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>

              <div className="md:col-span-4">
                <label htmlFor="pub-tag" className="block text-xs font-medium text-slate-600 mb-1.5">
                  Release Tag
                </label>
                <input
                  id="pub-tag"
                  type="text"
                  value={pubTag}
                  onChange={(e) => setPubTag(e.target.value)}
                  placeholder="v1.0.0"
                  className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>

              <div className="md:col-span-6">
                <label htmlFor="pub-title" className="block text-xs font-medium text-slate-600 mb-1.5">
                  Release Title
                </label>
                <input
                  id="pub-title"
                  type="text"
                  value={pubTitle}
                  onChange={(e) => setPubTitle(e.target.value)}
                  placeholder="NetPulse TV v1.0.0"
                  className="w-full h-10 px-3 text-sm bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>

              <div className="md:col-span-6">
                <label htmlFor="pub-apk-file" className="block text-xs font-medium text-slate-600 mb-1.5">
                  Signed / Debug Android Package (.apk, .xapk, .apks)
                </label>
                <input
                  id="pub-apk-file"
                  type="file"
                  accept=".apk,.xapk,.apks,.aab"
                  onChange={(e) => setPubFile(e.target.files?.[0] ?? null)}
                  className="w-full h-10 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-700 file:mr-3 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-medium file:bg-slate-100 file:text-slate-800 hover:file:bg-slate-200"
                />
              </div>

              <div className="md:col-span-12">
                <label htmlFor="pub-notes" className="block text-xs font-medium text-slate-600 mb-1.5">
                  Release Notes
                </label>
                <textarea
                  id="pub-notes"
                  rows={2}
                  value={pubNotes}
                  onChange={(e) => setPubNotes(e.target.value)}
                  className="w-full p-3 text-xs bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>

              <div className="md:col-span-12 flex flex-wrap items-center justify-between gap-4 pt-1">
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pubPrerelease}
                    onChange={(e) => setPubPrerelease(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                  />
                  Mark as pre-release
                </label>

                <button
                  type="submit"
                  disabled={publishing || !ghStatus?.configured || !ghStatus?.tokenValid}
                  className="inline-flex items-center gap-2 h-10 px-5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <Upload className="w-4 h-4" />
                  {publishing ? 'Publishing Release...' : 'Publish APK to GitHub'}
                </button>
              </div>
            </form>

            {publishError && (
              <div className="p-3.5 border border-red-200 bg-red-50/70 rounded-md text-sm text-red-800">
                {publishError}
              </div>
            )}

            {publishResult && (
              <div className="p-4 border border-emerald-200 bg-emerald-50/60 rounded-lg space-y-2 text-sm">
                <div className="font-semibold text-emerald-900">
                  Published {publishResult.assetName} ({formatBytes(publishResult.assetSize)}) to{' '}
                  {publishResult.tagName}
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <a
                    href={publishResult.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline"
                  >
                    Open GitHub Release
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <a
                    href={publishResult.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-slate-800 hover:underline"
                  >
                    Direct APK Asset URL
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Section 3: Local Wi-Fi ADB Sideload Helper */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div className="pb-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-slate-600" />
            <h2 className="text-base font-semibold text-slate-900">
              Local Wi-Fi ADB Sideload Commands (Android TV / Google TV)
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Prefer pushing an APK directly over your home Wi-Fi with Network Debugging enabled on
            your TV? Enter your TV&apos;s LAN IP from the LAN Devices tab to generate exact ADB
            commands.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="adb-tv-ip" className="block text-xs font-medium text-slate-600 mb-1.5">
              Android TV Local IP
            </label>
            <input
              id="adb-tv-ip"
              type="text"
              value={tvLanIp}
              onChange={(e) => setTvLanIp(e.target.value)}
              placeholder="192.168.1.45"
              className="w-full h-9 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>
          <div>
            <label htmlFor="adb-file-name" className="block text-xs font-medium text-slate-600 mb-1.5">
              Local File / APK Name
            </label>
            <input
              id="adb-file-name"
              type="text"
              value={adbFilename}
              onChange={(e) => setAdbFilename(e.target.value)}
              placeholder="app-release.apk"
              className="w-full h-9 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>
        </div>

        <div className="space-y-2.5">
          {[
            { id: 'adb-connect', label: '1. Pair over Wi-Fi', cmd: adbConnectCmd },
            { id: 'adb-install', label: '2. Sideload APK', cmd: adbInstallCmd },
            { id: 'adb-push', label: '3. Transfer File to TV Downloads', cmd: adbPushCmd },
          ].map((item) => (
            <div
              key={item.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-slate-50 border border-slate-200 rounded-md"
            >
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-slate-500">{item.label}</div>
                <code className="text-xs font-mono text-slate-900 break-all">{item.cmd}</code>
              </div>
              <button
                type="button"
                onClick={() => void copyText(item.id, item.cmd)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 whitespace-nowrap shrink-0 self-start sm:self-auto"
              >
                {copiedKey === item.id ? (
                  <Check className="w-3.5 h-3.5 text-emerald-700" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {copiedKey === item.id ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
