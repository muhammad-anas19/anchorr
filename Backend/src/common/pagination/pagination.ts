// Two pagination shapes, because they solve genuinely different problems — this project
// uses each where it actually fits rather than picking one everywhere.
//
// OFFSET (page/pageSize): the caller can jump to any page and knows the total up front, which
// is what a queue table with page numbers and per-tab counts needs. The cost: `OFFSET n` makes
// Postgres walk and discard n rows, so deep pages get slower the further in you go, and rows
// SHIFT between requests — if a new row lands at the top while you're reading page 1, the row
// that was last on page 1 slides onto page 2 and you see it twice.
//
// CURSOR (keyset): "give me the rows after this exact row", translated to a `WHERE id < :cursor`
// that an index can seek straight to — the same speed on page 500 as on page 1, and immune to
// the shifting problem above because the anchor is a row, not a count. The cost: no total, and
// no jumping to an arbitrary page. That's the right trade for an append-only transcript being
// scrolled backwards, and the wrong trade for a table with page numbers.

export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CursorPage<T> {
  items: T[];
  // Pass back as `cursor` to fetch the next slice. null means there is nothing older.
  nextCursor: string | null;
  hasMore: boolean;
}

export function buildOffsetPage<T>(items: T[], total: number, page: number, pageSize: number): OffsetPage<T> {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}

// Fetching limit+1 rows and trimming is how `hasMore` is answered without a second COUNT
// query — if the extra row came back, there is at least one more.
export function buildCursorPage<T>(rows: T[], limit: number, toCursor: (row: T) => string): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? toCursor(items[items.length - 1]) : null,
    hasMore,
  };
}
