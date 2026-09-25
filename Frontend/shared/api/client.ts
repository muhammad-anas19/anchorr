import { BACKEND_URL } from '../config';
import { getToken } from '../auth/token';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// The one place every feature's API module routes through — attaches the stored JWT (if
// any) as a Bearer header and normalizes error handling into a single ApiError shape.
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const isFormData = options.body instanceof FormData;

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      ...options,
      headers: {
        // FormData sets its own multipart boundary in Content-Type — never override it.
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch (err) {
    // fetch rejects with a bare `TypeError: Failed to fetch` when the request never reached a
    // server — offline, DNS failure, CORS rejection, backend not running. That string is the
    // browser's, not ours, and it tells a user nothing. Status 0 marks "no HTTP response at
    // all", which is genuinely different from any real status code.
    if (isAbortError(err)) throw err;
    throw new ApiError(0, 'Could not reach the server. Check that the backend is running.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, body.message ?? 'Request failed');
  }

  // A 204, or a 200 with no body (e.g. this project's DELETE endpoints), both come back
  // with nothing to parse — res.json() would throw on an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Builds `?a=1&b=two`, skipping anything undefined/null/empty so an untouched filter never
// appears in the URL. URLSearchParams handles the encoding, which is what keeps a search for
// "100%" or "a&b" from corrupting the query string.
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

// An aborted fetch rejects like any other failure. Callers need to tell "I cancelled this
// myself because a newer request superseded it" apart from "the request actually failed",
// otherwise every superseded keystroke paints an error banner.
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
