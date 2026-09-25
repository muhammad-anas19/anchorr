// The filter controls themselves now live in the shared DataTable's own toolbar — only the
// filter types and the predicate they describe are still owned by this feature.
export type StatusFilter = 'all' | 'ready' | 'processing' | 'failed';
export type TypeFilter = 'all' | 'pdf' | 'docx';

// Client-side, unlike the agent console's queue, and deliberately so: this endpoint returns
// every document in the workspace in one response with no pagination, so filtering in the
// browser matches what the Backend actually offers. If the document list ever grows past a
// single page, this moves server-side the way the handoff queue already has.
export function matchesFilters(
  doc: { originalFilename: string; status: string; mimeType: string },
  search: string,
  status: StatusFilter,
  type: TypeFilter,
): boolean {
  if (search && !doc.originalFilename.toLowerCase().includes(search.toLowerCase())) return false;
  if (status === 'ready' && doc.status !== 'ready') return false;
  if (status === 'processing' && doc.status !== 'uploaded' && doc.status !== 'processing') return false;
  if (status === 'failed' && doc.status !== 'failed') return false;
  if (type === 'pdf' && doc.mimeType !== 'application/pdf') return false;
  if (type === 'docx' && doc.mimeType === 'application/pdf') return false;
  return true;
}
