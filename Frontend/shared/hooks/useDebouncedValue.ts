'use client';

import { useEffect, useState } from 'react';

// Returns `value` only once it has stopped changing for `delay` ms. Typing "invoice" fires one
// request instead of seven: each keystroke clears the previous timer before it can elapse.
//
// Debouncing the VALUE rather than the request is deliberate — the input stays fully
// controlled and responsive (it re-renders on every keystroke), while whatever effect depends
// on the debounced copy runs at most once per pause.
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
