// 3_410_000 → "3.41M", 82_400 → "82.4k", 942 → "942". Compact for tiles; exact values live in
// the chart's table view and tooltips.
export function compact(value: number): string {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 10_000) return `${trim(value / 1_000)}k`;
  return value.toLocaleString();
}

function trim(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}

export function percent(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

// Periods are UTC by construction (the report says so); dates are shown in UTC too, so the
// "1 September" on screen is the same day the server bucketed by.
export function utcDate(iso: string, withYear = false): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}
