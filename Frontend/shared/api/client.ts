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

  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      // FormData sets its own multipart boundary in Content-Type — never override it.
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, body.message ?? 'Request failed');
  }

  // A 204, or a 200 with no body (e.g. this project's DELETE endpoints), both come back
  // with nothing to parse — res.json() would throw on an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
