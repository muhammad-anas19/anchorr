'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../api/client';

// One place for the three things every list screen in this app needs and would otherwise
// re-implement (and get subtly wrong) per page:
//
//  1. Refetch when the inputs change — driven by `key`, a serialized copy of the params. The
//     fetcher itself is held in a ref, so a caller can pass an inline arrow function without
//     causing an infinite effect loop from its changing identity.
//  2. Cancel the superseded request. Without this, a slow response for "inv" can resolve
//     AFTER the fast one for "invoice" and overwrite correct results with stale ones — the
//     classic out-of-order race a debounce alone does not fix.
//  3. Keep the previous data visible while the next request is in flight, so a table does not
//     blank out between keystrokes.
export function useFetch<T>(fetcher: (signal: AbortSignal) => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // A cancellation is this hook's own doing, not a failure worth showing anyone — and
        // the newer request that replaced it will resolve the loading state.
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : 'Could not load this.');
        setLoading(false);
      });

    return () => controller.abort();
  }, [key, reloadCount]);

  const refetch = useCallback(() => setReloadCount((n) => n + 1), []);

  return { data, loading, error, refetch };
}
