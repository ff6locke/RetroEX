import { useCallback, useEffect, useState } from 'react';
import {
  ExternalLink,
  Github,
  Hammer,
  LogOut,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  GithubRepoEntry,
  GithubStatusResponse,
  GithubWorkflowRun,
} from '../types/network';
import { apiUrl } from '../utils/apiUrl';

interface BuildApkModalProps {
  open: boolean;
  onClose: () => void;
}

const LAST_REPO_STORAGE_KEY = 'netpulse_last_github_repo_v1';

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

export function BuildApkModal({ open, onClose }: BuildApkModalProps) {
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

  const saveRepoToStorage = (owner: string, repo: string) => {
    try {
      localStorage.setItem(LAST_REPO_STORAGE_KEY, JSON.stringify({ owner, repo }));
    } catch {
      // Ignore storage errors
    }
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
            const reposData = await readJsonSafe<{
              ok: boolean;
              error?: string;
              repos?: GithubRepoEntry[];
            }>(reposRes, 'GitHub repos');
            if (reposRes.ok && reposData.ok && Array.isArray(reposData.repos)) {
              const list = reposData.repos;
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
    if (open) {
      void refreshGithubStatusAndRepos();
    }
  }, [open, refreshGithubStatusAndRepos]);

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

  const fetchWorkflowRuns = useCallback(
    async (ownerArg?: string, repoArg?: string, showErrors = false) => {
      const owner = (ownerArg ?? ghOwner).trim();
      const repo = (repoArg ?? ghRepo).trim();
      if (!owner || !repo) return;
      setRunsLoading(true);
      if (showErrors) setCompileError(null);
      try {
        const res = await fetch(
          apiUrl(
            `/api/github/workflow-runs?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`
          ),
          { cache: 'no-store', headers: buildGithubAuthHeaders() }
        );
        const data = await readJsonSafe<{
          ok: boolean;
          error?: string;
          runs?: GithubWorkflowRun[];
        }>(res, 'Workflow runs');
        if (res.ok && data.ok) {
          setWorkflowRuns(data.runs || []);
        } else if (showErrors) {
          setCompileError(data.error || `Could not check workflow runs (HTTP ${res.status}).`);
        }
      } catch (err) {
        if (showErrors) {
          setCompileError(
            err instanceof Error ? err.message : 'Unable to query GitHub Actions runs.'
          );
        }
      } finally {
        setRunsLoading(false);
      }
    },
    [ghOwner, ghRepo, buildGithubAuthHeaders]
  );

  useEffect(() => {
    if (!open) return;
    const hasActiveRun = workflowRuns.some(
      (r) => r.status === 'queued' || r.status === 'in_progress' || r.status === 'waiting'
    );
    if (!hasActiveRun || !ghOwner.trim() || !ghRepo.trim()) return;
    const timer = window.setInterval(() => {
      void fetchWorkflowRuns();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [open, workflowRuns, ghOwner, ghRepo, fetchWorkflowRuns]);

  if (!open) return null;

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
            'GitHub OAuth is not configured on the server. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in Secrets.'
        );
        setGhConnecting(false);
        return;
      }

      const authWindow = window.open(data.url, 'github_oauth_popup', 'width=620,height=720');
      if (!authWindow) {
        setGhAuthError(
          'Popup was blocked by your browser. Allow popups and click Connect GitHub again.'
        );
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
      const data = await readJsonSafe<{
        ok: boolean;
        error?: string;
        repo?: GithubRepoEntry;
      }>(res, 'Create GitHub repo');
      if (!res.ok || !data.ok || !data.repo) {
        setCreateRepoError(data.error || 'Could not create repository.');
        return;
      }
      const created = data.repo;
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="build-apk-title"
    >
      <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden my-auto">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 id="build-apk-title" className="text-base font-semibold text-slate-900">
              Compile Android TV APK on GitHub
            </h2>
            <p className="text-xs text-slate-500">
              Syncs this app and builds a standalone zero-server APK via GitHub Actions.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close APK builder"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="text-xs font-mono text-slate-600">
              {ghStatus === null
                ? 'Checking GitHub status...'
                : ghStatus.configured && ghStatus.tokenValid
                  ? `Connected as @${ghStatus.username}`
                  : 'GitHub Not Connected'}
            </div>
            {ghStatus?.configured && ghStatus?.tokenValid ? (
              ghStatus.authSource === 'oauth' && (
                <button
                  type="button"
                  onClick={() => void handleDisconnectGithub()}
                  className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-100 whitespace-nowrap"
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
                className="inline-flex items-center gap-2 h-8 px-3.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                <Github className="w-3.5 h-3.5" />
                {ghConnecting ? 'Connecting...' : 'Connect GitHub'}
              </button>
            )}
          </div>

          {ghAuthError && (
            <div className="p-3 border border-amber-200 bg-amber-50/70 rounded-md text-xs text-amber-900">
              {ghAuthError}
            </div>
          )}

          {ghStatus?.configured && ghStatus?.tokenValid && (
            <div className="space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
                <select
                  aria-label="Select GitHub repository"
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
                  className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {showCreateRepo ? 'Cancel' : 'New Repo'}
                </button>
              </div>

              {showCreateRepo && (
                <form
                  onSubmit={handleCreateRepo}
                  className="p-3 bg-slate-50 border border-slate-200 rounded-md flex flex-col sm:flex-row sm:items-center gap-2.5"
                >
                  <input
                    type="text"
                    value={newRepoName}
                    onChange={(e) => setNewRepoName(e.target.value)}
                    placeholder="netpulse-tv-apk"
                    aria-label="New GitHub repository name"
                    className="flex-1 h-9 px-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900"
                  />
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={newRepoPrivate}
                      onChange={(e) => setNewRepoPrivate(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600"
                    />
                    Private
                  </label>
                  <button
                    type="submit"
                    disabled={creatingRepo}
                    className="h-9 px-3.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    {creatingRepo ? 'Creating...' : 'Create'}
                  </button>
                  {createRepoError && (
                    <span className="text-xs text-red-600">{createRepoError}</span>
                  )}
                </form>
              )}
            </div>
          )}

          <form onSubmit={handleCompileOnGithub} className="grid grid-cols-1 sm:grid-cols-12 gap-3.5">
            <div className="sm:col-span-4">
              <label htmlFor="apk-owner" className="block text-xs font-medium text-slate-600 mb-1">
                GitHub Owner
              </label>
              <input
                id="apk-owner"
                type="text"
                value={ghOwner}
                onChange={(e) => setGhOwner(e.target.value)}
                placeholder="ff6locke"
                className="w-full h-9 px-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900"
              />
            </div>
            <div className="sm:col-span-5">
              <label htmlFor="apk-repo" className="block text-xs font-medium text-slate-600 mb-1">
                Repository
              </label>
              <input
                id="apk-repo"
                type="text"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                placeholder="Netpulse-tv-transfer"
                className="w-full h-9 px-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900"
              />
            </div>
            <div className="sm:col-span-3">
              <label htmlFor="apk-branch" className="block text-xs font-medium text-slate-600 mb-1">
                Branch
              </label>
              <input
                id="apk-branch"
                type="text"
                value={ghBranch}
                onChange={(e) => setGhBranch(e.target.value)}
                placeholder="main"
                className="w-full h-9 px-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900"
              />
            </div>

            <div className="sm:col-span-4">
              <label htmlFor="apk-tag" className="block text-xs font-medium text-slate-600 mb-1">
                Version Tag
              </label>
              <input
                id="apk-tag"
                type="text"
                value={compileTag}
                onChange={(e) => setCompileTag(e.target.value)}
                placeholder="v1.0.0"
                className="w-full h-9 px-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900"
              />
            </div>
            <div className="sm:col-span-4">
              <label htmlFor="apk-name" className="block text-xs font-medium text-slate-600 mb-1">
                App Name
              </label>
              <input
                id="apk-name"
                type="text"
                value={compileAppName}
                onChange={(e) => setCompileAppName(e.target.value)}
                placeholder="NetPulse TV"
                className="w-full h-9 px-3 text-xs bg-white border border-slate-200 rounded-md text-slate-900"
              />
            </div>
            <div className="sm:col-span-4">
              <label htmlFor="apk-id" className="block text-xs font-medium text-slate-600 mb-1">
                Package ID
              </label>
              <input
                id="apk-id"
                type="text"
                value={compileAppId}
                onChange={(e) => setCompileAppId(e.target.value)}
                placeholder="app.netpulse.tv"
                className="w-full h-9 px-3 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900"
              />
            </div>

            <div className="sm:col-span-12 flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={runsLoading || !ghOwner.trim() || !ghRepo.trim()}
                  onClick={() => void fetchWorkflowRuns(undefined, undefined, true)}
                  className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${runsLoading ? 'animate-spin' : ''}`} />
                  Check Status
                </button>
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={syncSource}
                    onChange={(e) => setSyncSource(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600"
                  />
                  Sync updated source
                </label>
              </div>

              <button
                type="submit"
                disabled={compiling || !ghStatus?.configured || !ghStatus?.tokenValid}
                className="inline-flex items-center gap-2 h-9 px-4 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
              >
                <Hammer className="w-3.5 h-3.5" />
                {compiling ? 'Starting Build...' : 'Compile APK on GitHub'}
              </button>
            </div>
          </form>

          {compileError && (
            <div className="p-3 border border-red-200 bg-red-50/70 rounded-md text-xs text-red-800">
              {compileError}
            </div>
          )}

          {compileMessage && (
            <div className="p-3.5 border border-emerald-200 bg-emerald-50/60 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="font-medium text-emerald-900">{compileMessage.text}</span>
              <a
                href={compileMessage.actionsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline whitespace-nowrap"
              >
                Watch on GitHub Actions
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}

          {workflowRuns.length > 0 && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-3.5 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs font-semibold text-slate-700">
                <span>Recent APK Builds</span>
                <span className="font-mono font-normal text-slate-500">
                  {ghOwner}/{ghRepo}
                </span>
              </div>
              <div className="divide-y divide-slate-100">
                {workflowRuns.map((run) => (
                  <div
                    key={run.id}
                    className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
                        · {new Date(run.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <a
                      href={run.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline whitespace-nowrap"
                    >
                      Open Build
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
