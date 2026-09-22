const TOKEN_KEY = 'anchor-console-token';

// Access-token only, no refresh-token rotation on this side — a deliberate scope boundary
// for this minimal console (see the phase doc). A 15-minute token expiring mid-shift means
// logging back in, not a silent failure.
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}
