import { TextField } from '../../shared/ui/TextField';

export type StatusFilter = 'all' | 'ready' | 'processing' | 'failed';
export type TypeFilter = 'all' | 'pdf' | 'docx';

export function DocumentsFilterBar({
  search,
  onSearchChange,
  status,
  onStatusChange,
  type,
  onTypeChange,
  totalCount,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  status: StatusFilter;
  onStatusChange: (value: StatusFilter) => void;
  type: TypeFilter;
  onTypeChange: (value: TypeFilter) => void;
  totalCount: number;
}) {
  const selectStyle: React.CSSProperties = {
    height: 30,
    padding: '0 8px',
    border: '1px solid #e7e7e4',
    borderRadius: 7,
    background: 'white',
    color: '#6b6b73',
    fontSize: 12.5,
    fontWeight: 500,
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid #e7e7e4', flexWrap: 'wrap' }}>
      <TextField
        placeholder="Search documents"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        style={{ height: 30, minWidth: 200, fontSize: 12.5 }}
      />
      <select value={status} onChange={(e) => onStatusChange(e.target.value as StatusFilter)} style={selectStyle}>
        <option value="all">Status: All</option>
        <option value="ready">Status: Ready</option>
        <option value="processing">Status: Processing</option>
        <option value="failed">Status: Failed</option>
      </select>
      <select value={type} onChange={(e) => onTypeChange(e.target.value as TypeFilter)} style={selectStyle}>
        <option value="all">Type: All</option>
        <option value="pdf">Type: PDF</option>
        <option value="docx">Type: DOCX</option>
      </select>
      <div style={{ flex: 1 }} />
      <div style={{ fontSize: 12, color: '#9a9aa2', fontFamily: 'monospace' }}>
        {totalCount} document{totalCount === 1 ? '' : 's'}
      </div>
    </div>
  );
}
