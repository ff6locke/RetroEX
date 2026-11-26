export type ProbeMode = 'browser' | 'server-tcp';

export type SampleStatus = 'ok' | 'timeout' | 'blocked' | 'error';

export type NavSection = 'tv-transfer' | 'lan-devices' | 'diagnose' | 'live' | 'multi' | 'dns-tcp';

export interface TvTransferFileItem {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
  uploadedAt: number;
  source: 'upload' | 'github';
  sourceDetail?: string;
  downloadUrl: string;
}

export interface TvTransferRoom {
  code: string;
  createdAt: number;
  expiresAt: number;
  files: TvTransferFileItem[];
}

export interface GithubStatusResponse {
  ok: boolean;
  configured: boolean;
  oauthConfigured?: boolean;
  callbackUrl?: string;
  authSource?: 'oauth' | 'env-token' | 'none';
  tokenValid?: boolean;
  username?: string;
  avatarUrl?: string;
  error?: string;
}

export interface GithubRepoEntry {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string;
}

export interface GithubWorkflowRun {
  id: number;
  runNumber: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  headBranch: string;
}

export interface GithubReleaseAsset {
  id: number;
  name: string;
  size: number;
  contentType: string;
  downloadCount: number;
  browserDownloadUrl: string;
  isApk: boolean;
}

export interface GithubReleaseEntry {
  id: number;
  tagName: string;
  name: string;
  prerelease: boolean;
  draft: boolean;
  publishedAt: string | null;
  htmlUrl: string;
  assets: GithubReleaseAsset[];
}

export interface PingSample {
  seq: number;
  timestamp: number;
  target: string;
  resolvedIp?: string;
  port?: number;
  rttMs: number | null;
  dnsMs?: number;
  status: SampleStatus;
  protocol: string;
  note?: string;
}

export interface PingStats {
  sent: number;
  received: number;
  lost: number;
  lossPct: number;
  latestMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  avgMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  jitterMs: number | null;
}

export interface TargetPreset {
  id: string;
  label: string;
  target: string;
  description: string;
  browserUrl?: string;
  tcpHost?: string;
  defaultPort?: number;
  isSelf?: boolean;
  isLocalLan?: boolean;
}

export interface MultiTargetRow {
  id: string;
  label: string;
  url: string;
  category: 'Edge' | 'DNS' | 'Cloud' | 'Local' | 'Custom';
  probing: boolean;
  samples: number[];
  failures: number;
  lastStatus: SampleStatus | 'idle';
  lastRttMs: number | null;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  jitterMs: number | null;
  lastCheckedAt: number | null;
  errorNote?: string;
}

export interface DnsLookupResult {
  ok: boolean;
  host: string;
  resolveMs?: number;
  addresses?: Array<{ address: string; family: 4 | 6 }>;
  ipv4?: string[];
  ipv6?: string[];
  cname?: string[];
  error?: string;
}

export interface SavedSessionRun {
  id: string;
  startedAt: number;
  endedAt: number;
  mode: ProbeMode;
  target: string;
  port?: number;
  stats: PingStats;
  samples: PingSample[];
}

export interface ClientNetworkContext {
  observedIp: string;
  effectiveType?: string;
  downlinkMbps?: number;
  hardwareRttMs?: number;
  saveData?: boolean;
  online: boolean;
}
