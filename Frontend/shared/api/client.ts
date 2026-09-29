import { BACKEND_URL } from '../config';
import { getToken, getRefreshToken } from '../auth/token';
import { getValidAccessToken, redirectToLogin, refreshSession } from '../auth/session';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}


const NO_REFRESH_PATHS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;

  const send = async (token: string | null): Promise<Response> => {
    try {
      return await fetch(`${BACKEND_URL}${path}`, {
        ...options,
        headers: {
          ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ApiError(0, 'Could not reach the server. Check that the backend is running.');
    }
  };

  const refreshable = !NO_REFRESH_PATHS.some((p) => path.startsWith(p)) && getRefreshToken() !== null;

  let res = await send(refreshable ? await getValidAccessToken() : getToken());

  if (res.status === 401 && refreshable) {
    const fresh = await refreshSession();
    if (fresh) {
      res = await send(fresh);
    } else {
      redirectToLogin();
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, body.message ?? 'Request failed');
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
