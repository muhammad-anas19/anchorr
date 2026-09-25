'use client';

import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { EmptyState, SearchInput, Select } from './primitives';

// A column-driven table, generic over the row type. Features describe WHAT each column shows
// and how wide it is; this component owns every piece of layout, the toolbar, the empty state
// and the pager. Adding a table elsewhere means writing a columns array, not another grid.
export interface Column<T> {
  key: string;
  header: ReactNode;
  // A CSS grid track — '1fr' for the flexible column, a fixed px width for the rest. Kept as
  // a raw track rather than a number so a caller can use minmax() or auto where needed.
  width: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
}

export interface FilterConfig<V extends string = string> {
  ariaLabel: string;
  value: V;
  onChange: (value: V) => void;
  options: { value: V; label: string }[];
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  // Search is controlled by the parent because the parent owns the debounce and the request
  // — this component never fetches anything itself.
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  filters?: FilterConfig[];
  toolbarExtra?: ReactNode;
  tabs?: ReactNode;
  loading?: boolean;
  emptyMessage?: string;
  pagination?: {
    page: number;
    totalPages: number;
    total: number;
    pageSize: number;
    onPageChange: (page: number) => void;
  };
  minWidth?: number;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  search,
  filters,
  toolbarExtra,
  tabs,
  loading = false,
  emptyMessage = 'Nothing here yet.',
  pagination,
  minWidth = 620,
}: DataTableProps<T>) {
  const template = columns.map((c) => c.width).join(' ');

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: 'var(--shadow)',
        overflow: 'hidden',
      }}
    >
      {tabs}

      {(search || filters?.length || toolbarExtra) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
            flexWrap: 'wrap',
          }}
        >
          {search && (
            <SearchInput
              value={search.value}
              onChange={search.onChange}
              placeholder={search.placeholder}
              width={220}
            />
          )}
          {filters?.map((filter) => (
            <Select
              key={filter.ariaLabel}
              ariaLabel={filter.ariaLabel}
              value={filter.value}
              onChange={filter.onChange}
              options={filter.options}
            />
          ))}
          <div style={{ flex: 1 }} />
          {toolbarExtra}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: template,
            minWidth,
            gap: 12,
            alignItems: 'center',
            padding: '9px 16px',
            background: 'var(--surface-2)',
            borderBottom: '1px solid var(--border)',
            font: '600 11px/1 var(--font-sans)',
            letterSpacing: '.05em',
            textTransform: 'uppercase',
            color: 'var(--faint)',
          }}
        >
          {columns.map((column) => (
            <div key={column.key} style={{ textAlign: column.align ?? 'left' }}>
              {column.header}
            </div>
          ))}
        </div>

        {/* Stale rows stay visible at reduced opacity during a refetch rather than being
            replaced by a spinner — the table does not jump, and a debounced search does not
            flash empty between keystrokes. */}
        <div style={{ opacity: loading && rows.length > 0 ? 0.55 : 1, transition: 'opacity .12s ease' }}>
          {rows.length === 0 ? (
            <EmptyState>{loading ? 'Loading…' : emptyMessage}</EmptyState>
          ) : (
            rows.map((row, index) => (
              <div
                key={rowKey(row)}
                className="anc-row-hover"
                style={{
                  display: 'grid',
                  gridTemplateColumns: template,
                  minWidth,
                  gap: 12,
                  alignItems: 'center',
                  padding: '13px 16px',
                  borderBottom: index === rows.length - 1 ? 'none' : '1px solid var(--border)',
                }}
              >
                {columns.map((column) => (
                  <div key={column.key} style={{ minWidth: 0, textAlign: column.align ?? 'left' }}>
                    {column.render(row)}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {pagination && pagination.total > 0 && <Pager {...pagination} />}
    </div>
  );
}

function Pager({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
}: NonNullable<DataTableProps<unknown>['pagination']>) {
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface-2)',
      }}
    >
      <span style={{ font: '400 11.5px/1 var(--font-mono)', color: 'var(--muted)' }}>
        {first}–{last} of {total}
      </span>
      <div style={{ flex: 1 }} />
      <PagerButton label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        <Icon name="chevronLeft" size={12} strokeWidth={1.8} />
      </PagerButton>
      <span style={{ font: '400 11.5px/1 var(--font-mono)', color: 'var(--muted)' }}>
        {page} / {Math.max(totalPages, 1)}
      </span>
      <PagerButton label="Next page" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        <Icon name="chevronRight" size={12} strokeWidth={1.8} />
      </PagerButton>
    </div>
  );
}

function PagerButton({
  children,
  disabled,
  onClick,
  label,
}: {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={disabled ? undefined : 'anc-icon-btn'}
      style={{
        width: 26,
        height: 26,
        display: 'grid',
        placeItems: 'center',
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--surface)',
        color: 'var(--muted)',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}
