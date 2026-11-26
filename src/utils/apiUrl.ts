const API_BASE_STORAGE_KEY = 'netpulse_api_base_url_v1';

export function normalizeBaseUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === 'MY_APP_URL') return '';
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}

export function isNativeCapacitorOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  const origin = window.location.origin.toLowerCase();
  return (
    origin === 'https://localhost' ||
    origin === 'http://localhost' ||
    origin.startsWith('capacitor://') ||
    origin.startsWith('ionic://')
  );
}

export function isAiStudioAuthGatedUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return /^ais-dev-/i.test(parsed.hostname) && parsed.hostname.endsWith('.run.app');
  } catch {
    return false;
  }
}

export function getSavedApiBaseOverride(): string {
  if (typeof window === 'undefined') return '';
  try {
    return normalizeBaseUrl(localStorage.getItem(API_BASE_STORAGE_KEY));
  } catch {
    return '';
  }
}

export function setSavedApiBaseOverride(url: string): string {
  const normalized = normalizeBaseUrl(url);
  if (typeof window !== 'undefined') {
    try {
      if (normalized) {
        localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
      } else {
        localStorage.removeItem(API_BASE_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }
  return normalized;
}

export function getBakedApiBaseUrl(): string {
  return normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);
}

export function getApiBaseUrl(): string {
  const override = getSavedApiBaseOverride();
  if (override) return override;
  const envBase = getBakedApiBaseUrl();
  if (envBase) return envBase;
  return '';
}

export function hasReachableBackendConfig(): boolean {
  if (!isNativeCapacitorOrigin()) return true;
  const base = getApiBaseUrl();
  if (!base) return false;
  if (isAiStudioAuthGatedUrl(base)) return false;
  return true;
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBaseUrl();
  return base ? `${base}${cleanPath}` : cleanPath;
}

export function getPublicAppOrigin(): string {
  const base = getApiBaseUrl();
  if (base) return base;
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return '';
}
