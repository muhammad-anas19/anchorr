// Builds a "contains" pattern for ILIKE from user input, with the input's own LIKE
// metacharacters escaped.
//
// Binding the value as a parameter already prevents SQL injection — the query's shape cannot
// change. But inside a LIKE pattern, % and _ are still wildcards: unescaped, a search for
// "100%" matches "100" followed by anything, and "a_b" matches "axb". Escaping makes the
// search mean what was typed. Pair it with ILIKE ... ESCAPE (one backslash).
//
// The backslash itself must be escaped too, or a user's own "\" would escape whatever follows it.
const ESCAPE_CHAR = '\\';
export function containsPattern(input: string): string {
  const escaped = input.replace(/[\\%_]/g, (char) => ESCAPE_CHAR + char);
  return '%' + escaped + '%';
}
