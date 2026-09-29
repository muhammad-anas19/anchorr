import { BACKEND_URL } from '../config';
import {
  clearSession,
  getRefreshToken,
  getToken,
  setSession,
  type SessionTokens,
} from './token';


const EXPIRY_SKEW_SECONDS = 30;


let inFlight: Promise<string | null> | null = null;

function readExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    // A JWT payload is base64url, not base64 — atob rejects the - and _ characters.
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}


export function isExpired(token: string, skewSeconds = EXPIRY_SKEW_SECONDS): boolean {
  const exp = readExpiry(token);
  if (exp === null) return false;
  return exp * 1000 <= Date.now() + skewSeconds * 1000;
}

export function refreshSession(): Promise<string | null> {
  if (!inFlight) {
    inFlight = performRefresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function performRefresh(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    return null;
  }

  if (!res.ok) {
    clearSession();
    return null;
  }

  const tokens = (await res.json()) as SessionTokens;
  setSession(tokens);
  return tokens.accessToken;
}


export async function getValidAccessToken(): Promise<string | null> {
  const token = getToken();
  if (token && !isExpired(token)) return token;
  if (!getRefreshToken()) return token;
  return (await refreshSession()) ?? getToken();
}

export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const { pathname } = window.location;
  if (pathname === '/login' || pathname === '/register' || pathname.startsWith('/invite')) return;
  window.location.replace('/login');
}

export async function endSession(): Promise<void> {
  const refreshToken = getRefreshToken();
  clearSession();
  if (!refreshToken) return;
  try {
    await fetch(`${BACKEND_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
  }
}
