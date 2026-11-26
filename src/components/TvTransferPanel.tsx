import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Send,
  Terminal,
  Trash2,
  Tv,
  Upload,
} from 'lucide-react';
import type {
  GithubReleaseAsset,
  GithubReleaseEntry,
  GithubRepoEntry,
  GithubStatusResponse,
  GithubWorkflowRun,
  TvTransferRoom,
} from '../types/network';
import { QrCodeSvg } from './QrCodeSvg';
import {
  apiUrl,
  getApiBaseUrl,
  getPublicAppOrigin,
  isAiStudioAuthGatedUrl,
  isNativeCapacitorOrigin,
  setSavedApiBaseOverride,
} from '../utils/apiUrl';

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
  return 'Document';
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
  const [room, setRoom] = useState<TvTransferRoom | null>(null);
  const [roomLoading, setRoomLoading] = useState(true);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [joinCodeInput, setJoinCodeInput] = useState(initialRoomCode || '');
  const [serverUrlInput, setServerUrlInput] = useState(() => getApiBaseUrl());
  const [needsServerConfig, setNeedsServerConfig] = useState(false);

  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // GitHub state (session ID kept strictly in React memory, never localStorage)
  const [ghSessionId, setGhSessionId] = useState<string | null>(null);
  const [ghTab, setGhTab] = useState<'compile' | 'browse' | 'publish'>('compile');
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
  const [importingRunId, setImportingRunId] = useState<number | null>(null);

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
  const [queueingAssetId, setQueueingAssetId] = useState<number | null>(null);

  // Publish APK to GitHub state
  const [pubTag, setPubTag] = useState('v1.0.0');
  const [pubTitle, setPubTitle] = useState('NetPulse TV v1.0.0');
  const [pubNotes, setPubNotes] = useState('Android & TV APK release.');
  const [pubPrerelease, setPubPrerelease] = useState(false);
  const [pubQueueToTv, setPubQueueToTv] = useState(true);
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

  const formatRoomNetworkError = useCallback((err: unknown, fallback: string): string => {
    const msg = err instanceof Error ? err.message : fallback;
    const base = getApiBaseUrl();
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      setNeedsServerConfig(true);
      if (isNativeCapacitorOrigin() && (!base || isAiStudioAuthGatedUrl(base))) {
        return 'Cannot reach the AI Studio dev URL from this standalone APK because AI Studio requires Google login cookies. Deploy the app to Cloud Run (or run NetPulse locally on your Wi-Fi) and enter that public server URL below.';
      }
      return `Unable to reach NetPulse server (${base || 'same origin'}). Check Wi-Fi or enter a reachable server URL below.`;
    }
    return msg;
  }, []);

  const createRoom = useCallback(async () => {
    setRoomLoading(true);
    setRoomError(null);
    try {
      const res = await fetch(apiUrl('/api/tv/rooms'), { method: 'POST' });
      const data = await readJsonSafe<{ ok: boolean; error?: string; room?: TvTransferRoom }>(
        res,
        'Create TV room'
      );
      if (!res.ok || !data.ok || !data.room) {
        setRoomError(data.error || 'Unable to create a TV transfer room.');
        return;
      }
      setNeedsServerConfig(false);
      setRoom(data.room);
      setJoinCodeInput(data.room.code);
    } catch (err) {
      setRoomError(formatRoomNetworkError(err, 'Network error creating room.'));
    } finally {
      setRoomLoading(false);
    }
  }, [formatRoomNetworkError]);

  const joinRoom = useCallback(
    async (code: string, fallbackToCreate = false) => {
      const clean = code.replace(/\D/g, '').slice(0, 6);
      if (clean.length !== 6) {
        setRoomError('Enter a 6-digit TV pairing code.');
        setRoomLoading(false);
        return;
      }
      setRoomLoading(true);
      setRoomError(null);
      try {
        const res = await fetch(apiUrl(`/api/tv/rooms/${clean}`), { cache: 'no-store' });
        const data = await readJsonSafe<{ ok: boolean; error?: string; room?: TvTransferRoom }>(
          res,
          'Join TV room'
        );
        if (!res.ok || !data.ok || !data.room) {
          if (fallbackToCreate) {
            await createRoom();
            return;
          }
          setRoomError(data.error || `Room ${clean} not found or expired.`);
          return;
        }
        setNeedsServerConfig(false);
        setRoom(data.room);
        setJoinCodeInput(data.room.code);
      } catch (err) {
        setRoomError(formatRoomNetworkError(err, 'Unable to join transfer room.'));
      } finally {
        setRoomLoading(false);
      }
    },
    [createRoom, formatRoomNetworkError]
  );

  // Initialize room on mount
  useEffect(() => {
    if (initialRoomCode && /^\d{6}$/.test(initialRoomCode)) {
      void joinRoom(initialRoomCode, true);
    } else {
      void createRoom();
    }
  }, [initialRoomCode, joinRoom, createRoom]);

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

  // Subscribe to SSE live updates for current room
  useEffect(() => {
    if (!room?.code) return;
    const source = new EventSource(apiUrl(`/api/tv/rooms/${room.code}/events`));
    source.addEventListener('room', (evt) => {
      try {
        const updated = JSON.parse((evt as MessageEvent).data) as TvTransferRoom;
        setRoom(updated);
      } catch {
        // Ignore invalid frame
      }
    });
    return () => {
      source.close();
    };
  }, [room?.code]);

  // Auto-sync ADB helper filename with latest APK in room
  useEffect(() => {
    const apk = room?.files.find((f) => /\.(apk|xapk|apks)$/i.test(f.name));
    if (apk) {
      setAdbFilename(apk.name);
    }
  }, [room?.files]);

  const uploadFilesToRoom = (files: FileList | File[]) => {
    if (!room?.code) {
      setUploadError('Create or join a TV transfer room first.');
      return;
    }
    const list = Array.from(files);
    if (list.length === 0) return;
    if (list.length > 5) {
      setUploadError('Upload up to 5 files per batch.');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);

    const formData = new FormData();
    for (const f of list) {
      formData.append('files', f);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl(`/api/tv/rooms/${room.code}/upload`));

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
      }
    };

    xhr.onload = () => {
      setUploading(false);
      setUploadProgress(0);
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && data.ok && data.room) {
          setRoom(data.room);
        } else {
          setUploadError(data.error || 'Upload failed.');
        }
      } catch {
        setUploadError('Invalid server response during upload.');
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      setUploadProgress(0);
      setUploadError('Network error while uploading file to TV room.');
    };

    xhr.send(formData);
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!room?.code) return;
    try {
      const res = await fetch(apiUrl(`/api/tv/rooms/${room.code}/files/${fileId}`), {
        method: 'DELETE',
      });
      const data = await res.json();
      if (res.ok && data.ok && data.room) {
        setRoom(data.room);
      }
    } catch {
      // Ignore transient delete error
    }
  };

  const saveRepoToStorage = (owner: string, repo: string) => {
    try {
      localStorage.setItem(LAST_REPO_STORAGE_KEY, JSON.stringify({ owner, repo }));
    } catch {
      // Ignore storage errors
    }
  };

  const handleConnectGithub = async () => {
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
      if (!owner || !repo) return;
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

  const handleImportRunArtifactToTv = async (runId: number) => {
    if (!room?.code) {
      setCompileError('Create or join a TV transfer room above first.');
      return;
    }
    setImportingRunId(runId);
    setCompileError(null);
    try {
      const res = await fetch(apiUrl(`/api/tv/rooms/${room.code}/import-github-artifact`), {
        method: 'POST',
        headers: buildGithubAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          owner: ghOwner.trim(),
          repo: ghRepo.trim(),
          runId,
        }),
      });
      const data = await readJsonSafe<{
        ok: boolean;
        error?: string;
        room?: TvTransferRoom;
        fileName?: string;
      }>(res, 'Import APK artifact');
      if (!res.ok || !data.ok) {
        setCompileError(data.error || 'Could not import compiled APK from GitHub Actions.');
        return;
      }
      if (data.room) setRoom(data.room);
      setCompileMessage({
        text: `Imported ${data.fileName || 'APK'} into TV Transfer Queue (Room ${room.code}).`,
        actionsUrl: `https://github.com/${ghOwner.trim()}/${ghRepo.trim()}/actions/runs/${runId}`,
      });
    } catch (err) {
      setCompileError(err instanceof Error ? err.message : 'Failed to import compiled APK artifact.');
    } finally {
      setImportingRunId(null);
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

      try {
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
        // Fallback directly to public GitHub API when running inside standalone APK without NetPulse backend
        try {
          const publicRes = await fetch(
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=15`,
            { headers: { Accept: 'application/vnd.github+json' } }
          );
          if (publicRes.ok) {
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
            return;
          }
        } catch {
          // Ignore fallback failure and surface original error
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

  const handleQueueGithubAsset = async (asset: GithubReleaseAsset) => {
    if (!room?.code) {
      setReleasesError('Start or join a TV transfer room above first.');
      return;
    }
    setQueueingAssetId(asset.id);
    setReleasesError(null);
    try {
      const res = await fetch(apiUrl(`/api/tv/rooms/${room.code}/import-github-asset`), {
        method: 'POST',
        headers: buildGithubAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          owner: ghOwner.trim(),
          repo: ghRepo.trim(),
          assetId: asset.id,
        }),
      });
      const data = await readJsonSafe<{ ok: boolean; error?: string; room?: TvTransferRoom }>(
        res,
        'Import release asset'
      );
      if (!res.ok || !data.ok) {
        setReleasesError(data.error || 'Unable to queue asset to TV room.');
        return;
      }
      if (data.room) setRoom(data.room);
    } catch (err) {
      setReleasesError(err instanceof Error ? err.message : 'Failed to import asset.');
    } finally {
      setQueueingAssetId(null);
    }
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
      if (pubQueueToTv && room?.code) {
        formData.append('roomCode', room.code);
      }
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
        room?: TvTransferRoom;
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
      if (data.room) {
        setRoom(data.room);
      }
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Network error publishing APK.');
    } finally {
      setPublishing(false);
    }
  };

  const tvReceiverUrl = useMemo(() => {
    if (typeof window === 'undefined' || !room?.code) return '';
    return `${getPublicAppOrigin()}/?tv=${room.code}`;
  }, [room?.code]);

  const cleanTvIp = tvLanIp.trim() || '192.168.1.45';
  const cleanAdbFile = adbFilename.trim() || 'app-release.apk';
  const adbConnectCmd = `adb connect ${cleanTvIp}:5555`;
  const adbInstallCmd = `adb -s ${cleanTvIp}:5555 install -r "${cleanAdbFile}"`;
  const adbPushCmd = `adb -s ${cleanTvIp}:5555 push "${cleanAdbFile}" /sdcard/Download/`;

  return (
    <div className="space-y-6">
      {/* Section 1: TV File Transfer Workspace */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 text-balance">
              TV File Transfer &amp; APK Delivery
            </h1>
            <p className="mt-1 text-sm text-slate-600 max-w-3xl">
              Send Android APKs, videos, subtitles, or archives from your browser straight to any
              Android TV, Google TV, or Smart TV browser using a 6-digit pairing code and QR link.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void createRoom()}
              disabled={roomLoading}
              className="inline-flex items-center gap-1.5 h-10 px-3.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              New Room
            </button>
            <button
              type="button"
              onClick={() => onOpenTvReceiver(room?.code)}
              className="inline-flex items-center gap-2 h-10 px-4 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Tv className="w-4 h-4" />
              Open TV Receiver Screen
            </button>
          </div>
        </div>

        {roomError && (
          <div className="p-3.5 border border-red-200 bg-red-50/70 rounded-md text-sm text-red-800 space-y-3">
            <div>{roomError}</div>
            {(needsServerConfig || isNativeCapacitorOrigin()) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const saved = setSavedApiBaseOverride(serverUrlInput);
                  setServerUrlInput(saved);
                  void createRoom();
                  void refreshGithubStatusAndRepos();
                }}
                className="flex flex-col sm:flex-row sm:items-center gap-2 pt-2 border-t border-red-200/80"
              >
                <input
                  type="url"
                  value={serverUrlInput}
                  onChange={(e) => setServerUrlInput(e.target.value)}
                  placeholder="https://your-deployed-app.run.app or http://192.168.1.10:3000"
                  aria-label="NetPulse backend server URL"
                  className="flex-1 h-9 px-3 text-xs font-mono bg-white border border-red-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="submit"
                    className="h-9 px-3.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
                  >
                    Save &amp; Connect
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSavedApiBaseOverride('');
                      setServerUrlInput('');
                    }}
                    className="h-9 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
                  >
                    Reset
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 7 cols: File Upload Dropzone & Queued Files */}
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
                  uploadFilesToRoom(e.dataTransfer.files);
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
                    uploadFilesToRoom(e.target.files);
                    e.target.value = '';
                  }
                }}
              />
              <Upload className="w-7 h-7 text-slate-500 mx-auto" />
              <div className="mt-3 text-sm font-semibold text-slate-900">
                Drop files or Android APKs here to send to TV
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Supports .apk, .xapk, .mp4, .mkv, .srt, .pdf, .zip · Up to 250 MB per file ·
                Expires in 2 hours
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={uploading || !room}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <FileUp className="w-4 h-4" />
                  {uploading ? `Uploading ${uploadProgress}%` : 'Choose Files'}
                </button>
              </div>

              {uploading && (
                <div className="mt-4 max-w-xs mx-auto space-y-1">
                  <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-600 transition-all"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-600">
                    {uploadProgress}% transferred
                  </div>
                </div>
              )}

              {uploadError && (
                <p className="mt-3 text-xs font-medium text-red-600">{uploadError}</p>
              )}
            </div>

            {/* Queued Files Table */}
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-200">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    TV Transfer Queue
                  </h2>
                  <p className="text-xs text-slate-500">
                    Files ready to download on your TV under pairing code{' '}
                    <span className="font-mono text-slate-800">{room?.code || '------'}</span>
                  </p>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {room?.files.length ?? 0} / 25 files
                </span>
              </div>

              {!room || room.files.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-500 border-b border-slate-100">
                  No files queued yet. Upload an APK or media file above, or import a release from
                  GitHub below.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                        <th className="py-2 pr-3">File</th>
                        <th className="py-2 px-3">Type</th>
                        <th className="py-2 px-3 text-right">Size</th>
                        <th className="py-2 pl-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {room.files.map((file) => {
                        const resolvedFileUrl = apiUrl(file.downloadUrl);
                        const absoluteDownloadUrl = resolvedFileUrl.startsWith('http')
                          ? resolvedFileUrl
                          : `${getPublicAppOrigin()}${resolvedFileUrl}`;
                        return (
                          <tr key={file.id} className="hover:bg-slate-50/70">
                            <td className="py-2.5 pr-3">
                              <div className="font-medium text-slate-900 break-all">{file.name}</div>
                              <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                                SHA-256: {file.sha256.slice(0, 12)}
                                {file.source === 'github' && file.sourceDetail
                                  ? ` · GitHub (${file.sourceDetail})`
                                  : ''}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                              {classifyTransferFile(file.name)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                              {formatBytes(file.size)}
                            </td>
                            <td className="py-2.5 pl-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => void copyText(`dl-${file.id}`, absoluteDownloadUrl)}
                                  title="Copy direct download URL"
                                  className="px-2 py-1 text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50"
                                >
                                  {copiedKey === `dl-${file.id}` ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </button>
                                <a
                                  href={resolvedFileUrl}
                                  download={file.name}
                                  title="Download file"
                                  className="inline-flex items-center gap-1 px-2.5 py-1 font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  Get
                                </a>
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteFile(file.id)}
                                  title="Remove from room"
                                  className="p-1 text-slate-500 hover:text-red-600"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Right 5 cols: Pairing Code, QR Code & TV Instructions */}
          <div className="lg:col-span-5 border border-slate-200 rounded-lg p-5 space-y-5 bg-slate-50/40">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-slate-500">Active TV Pairing Code</div>
                <div className="mt-1 text-3xl font-mono font-bold tracking-[0.18em] text-slate-900 tabular-nums">
                  {room?.code || '------'}
                </div>
                {room && (
                  <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                    Active until {new Date(room.expiresAt).toLocaleTimeString()}
                  </div>
                )}
              </div>
              {room && (
                <button
                  type="button"
                  onClick={() => void copyText('room-code', room.code)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 whitespace-nowrap"
                >
                  {copiedKey === 'room-code' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {copiedKey === 'room-code' ? 'Copied' : 'Copy Code'}
                </button>
              )}
            </div>

            {tvReceiverUrl && (
              <div className="flex flex-col sm:flex-row items-center gap-4 pt-4 border-t border-slate-200">
                <QrCodeSvg
                  value={tvReceiverUrl}
                  size={140}
                  label={`Open TV receiver for room ${room?.code}`}
                />
                <div className="min-w-0 space-y-2">
                  <div className="text-xs font-semibold text-slate-900">
                    Open on Your Smart TV
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Open this link in your TV browser (TV Bro, Downloader, or Chrome) to receive
                    queued files in real time:
                  </p>
                  <div className="text-[11px] font-mono text-slate-700 break-all bg-white border border-slate-200 rounded px-2.5 py-1.5">
                    {tvReceiverUrl}
                  </div>
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

            {/* Join a room already opened on the TV */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void joinRoom(joinCodeInput, false);
              }}
              className="pt-4 border-t border-slate-200 space-y-2"
            >
              <label htmlFor="join-tv-code" className="block text-xs font-medium text-slate-600">
                Opened Receiver Mode on your TV first? Pair with its code:
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
                  disabled={roomLoading}
                  className="h-9 px-3.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                >
                  Connect
                </button>
              </div>
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
                GitHub APK Cloud Compiler &amp; Releases
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
              Connect your GitHub account to compile an Android &amp; TV APK directly on GitHub
              Actions, publish APK releases, or stream release APKs straight to your TV.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {ghStatus?.configured && ghStatus?.tokenValid ? (
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
            )}

            <div
              className="inline-flex items-center p-1 bg-slate-100 rounded-lg shrink-0"
              role="tablist"
              aria-label="GitHub APK mode"
            >
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
                  Connect GitHub to Compile APKs Directly on GitHub Actions
                </div>
                <p className="leading-relaxed">
                  Click <strong>Connect GitHub</strong> above to sign in with GitHub OAuth (or set{' '}
                  <span className="font-mono">GITHUB_TOKEN</span> in Secrets). Once connected,
                  NetPulse installs{' '}
                  <span className="font-mono">.github/workflows/publish-apk.yml</span> into your
                  repository and dispatches the Android Gradle + Capacitor APK build directly on
                  GitHub&apos;s cloud runners.
                </p>
                {ghStatus && !ghStatus.oauthConfigured && ghStatus.callbackUrl && (
                  <p className="font-mono text-[11px] text-slate-600 break-all">
                    GitHub OAuth App Setup Callback: {ghStatus.callbackUrl}
                  </p>
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

              <div className="md:col-span-12">
                <label htmlFor="comp-server-url" className="block text-xs font-medium text-slate-600 mb-1.5">
                  APK Backend Server URL (optional — for TV Transfer rooms inside the APK)
                </label>
                <input
                  id="comp-server-url"
                  type="url"
                  value={compileServerUrl}
                  onChange={(e) => setCompileServerUrl(e.target.value)}
                  placeholder="https://your-deployed-cloud-run-app.run.app or http://192.168.1.10:3000"
                  className="w-full h-10 px-3 text-sm font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Leave blank to run network diagnostics standalone inside the APK or enter a public deployed URL / local LAN server IP (private <span className="font-mono">ais-dev</span> preview URLs require Google sign-in cookies and cannot be fetched directly by installed APKs).
                </p>
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

                      <div className="flex items-center gap-2.5">
                        {run.conclusion === 'success' && (
                          <>
                            <button
                              type="button"
                              disabled={!room || importingRunId === run.id}
                              onClick={() => void handleImportRunArtifactToTv(run.id)}
                              className="px-2.5 py-1 font-medium text-white bg-emerald-600 rounded hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap"
                            >
                              {importingRunId === run.id ? 'Importing APK...' : 'Send APK to TV'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setGhTab('browse');
                                void loadReleasesForRepo();
                              }}
                              className="px-2.5 py-1 font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 whitespace-nowrap"
                            >
                              Releases
                            </button>
                          </>
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
                  placeholder="e.g. your-github-username"
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
                  placeholder="e.g. netpulse-tv"
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
                  Enter a GitHub repository to load its APK releases
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Any `.apk` release assets found can be streamed straight into TV room{' '}
                  <span className="font-mono text-slate-700">{room?.code || '------'}</span> for
                  one-click TV installation.
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
                              <button
                                type="button"
                                disabled={!room || queueingAssetId === asset.id}
                                onClick={() => void handleQueueGithubAsset(asset)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                              >
                                <Send className="w-3 h-3" />
                                {queueingAssetId === asset.id ? 'Queueing...' : 'Send to TV Room'}
                              </button>
                              <a
                                href={asset.browserDownloadUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1.5 font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 whitespace-nowrap"
                              >
                                Direct Link
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
            {(!ghStatus?.configured || !ghStatus?.tokenValid) && (
              <div className="p-4 border border-slate-200 bg-slate-50 rounded-lg space-y-2 text-sm">
                <div className="flex items-center gap-2 font-semibold text-slate-900">
                  <Github className="w-4 h-4 text-slate-700" />
                  Two Ways to Publish Your APK to GitHub
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  <strong>Option A (GitHub Actions — Zero Token Setup):</strong> This project now
                  includes{' '}
                  <span className="font-mono text-slate-800">
                    .github/workflows/publish-apk.yml
                  </span>
                  . After pushing to your authenticated GitHub repository, open the{' '}
                  <strong>Actions</strong> tab on GitHub and run{' '}
                  <strong>Build and Publish Android APK</strong> — it compiles the app into an
                  Android APK and publishes it automatically to GitHub Releases.
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  <strong>Option B (Direct Upload from Here):</strong> Add a{' '}
                  <span className="font-mono text-slate-800">GITHUB_TOKEN</span> secret (with{' '}
                  <span className="font-mono text-slate-800">repo</span> permissions) in AI Studio
                  Secrets to upload local `.apk` files straight to a GitHub Release below.
                </p>
              </div>
            )}

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
                <div className="flex flex-wrap items-center gap-5 text-xs text-slate-700">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pubPrerelease}
                      onChange={(e) => setPubPrerelease(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                    />
                    Mark as pre-release
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pubQueueToTv}
                      onChange={(e) => setPubQueueToTv(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                    />
                    Also queue published APK to TV room ({room?.code || '------'})
                  </label>
                </div>

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
            Prefer pushing an APK or large video directly over your home Wi-Fi with USB/Network
            Debugging enabled on your TV? Enter your TV&apos;s LAN IP from the LAN Devices tab to
            generate exact ADB commands.
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
