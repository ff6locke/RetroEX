const API_BASE_STORAGE_KEY = 'netpulse_api_base_url_v1';

function normalizeBaseUrl(raw: string | undefined | null): string {
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

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    try {
      const override = normalizeBaseUrl(localStorage.getItem(API_BASE_STORAGE_KEY));
      if (override) return override;
    } catch {
      // Ignore storage errors
    }
  }
  const envBase = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);
  if (envBase) return envBase;
  return '';
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
