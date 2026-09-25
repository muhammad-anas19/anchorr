'use client';

import toast from 'react-hot-toast';
import { ApiError, isAbortError } from '../api/client';

// Every feature reports through these rather than calling react-hot-toast directly, so the
// wording, the duration and — most importantly — the way an API error is turned into a
// message stay identical across the app. Swapping the toast library later is a change to
// this file, not to a dozen call sites.

export function notifySuccess(message: string): void {
  toast.success(message);
}

// The Backend already returns a useful `message` on every error (shared/api/client maps it
// onto ApiError), so the server's own words beat a generic fallback whenever we have them.
export function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function notifyError(error: unknown, fallback: string): void {
  // A request this app cancelled itself (a superseded search keystroke) is not a failure and
  // must never surface as a toast.
  if (isAbortError(error)) return;
  toast.error(toMessage(error, fallback));
}

// For a mutation whose result the user is waiting on: one toast that starts as a spinner and
// resolves in place, instead of a success toast appearing next to a stale loading one.
export async function withToast<T>(
  promise: Promise<T>,
  messages: { loading: string; success: string | ((value: T) => string); error: string },
): Promise<T> {
  return toast.promise(promise, {
    loading: messages.loading,
    success: (value: T) =>
      typeof messages.success === 'function' ? messages.success(value) : messages.success,
    error: (err: unknown) => toMessage(err, messages.error),
  });
}
