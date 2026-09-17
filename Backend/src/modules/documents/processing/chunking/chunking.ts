export interface Chunk {
  content: string;
  charStart: number;
  charEnd: number;
}

const TARGET_CHUNK_SIZE = 1000;
const OVERLAP_SIZE = 150;
// How far back from the target cut point we're willing to look for a nicer boundary
// (a paragraph break, then a sentence end, then plain whitespace) before giving up and
// just cutting at the raw target position.
const BOUNDARY_SEARCH_WINDOW = 200;

/**
 * Splits text into overlapping, boundary-snapped chunks. Each chunk's charStart/charEnd
 * are offsets into the original `text`, so `text.slice(chunk.charStart, chunk.charEnd)`
 * always reproduces `chunk.content` exactly.
 */
export function chunkText(text: string): Chunk[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  // Work against the original (untrimmed) text so offsets stay valid, but skip any
  // leading whitespace the trim above revealed.
  const start = text.indexOf(trimmed[0]);
  const end = start + trimmed.length;

  if (end - start <= TARGET_CHUNK_SIZE) {
    return [{ content: text.slice(start, end), charStart: start, charEnd: end }];
  }

  const chunks: Chunk[] = [];
  let cursor = start;

  while (cursor < end) {
    const tentativeEnd = Math.min(cursor + TARGET_CHUNK_SIZE, end);
    const chunkEnd = tentativeEnd === end ? end : snapToBoundary(text, cursor, tentativeEnd);

    chunks.push({ content: text.slice(cursor, chunkEnd), charStart: cursor, charEnd: chunkEnd });

    if (chunkEnd >= end) {
      break;
    }

    // Always move forward by at least 1 character, even if overlap would otherwise push
    // the next cursor backward past (or equal to) the current one — guarantees termination
    // regardless of how OVERLAP_SIZE and TARGET_CHUNK_SIZE are tuned relative to each other.
    const nextCursor = chunkEnd - OVERLAP_SIZE;
    cursor = Math.max(nextCursor, cursor + 1);
  }

  return chunks;
}

/**
 * Looks backward from `tentativeEnd` (within BOUNDARY_SEARCH_WINDOW characters, and never
 * before `rangeStart`) for a nicer place to cut: a paragraph break first, then a
 * sentence-ending punctuation mark followed by whitespace, then plain whitespace. Falls
 * back to the raw tentative position if nothing suitable is found.
 */
function snapToBoundary(text: string, rangeStart: number, tentativeEnd: number): number {
  const searchFloor = Math.max(rangeStart, tentativeEnd - BOUNDARY_SEARCH_WINDOW);
  const window = text.slice(searchFloor, tentativeEnd);

  const paragraphBreak = window.lastIndexOf('\n\n');
  if (paragraphBreak !== -1) {
    return searchFloor + paragraphBreak;
  }

  const sentenceEnd = window.match(/[.!?]\s+(?!.*[.!?]\s+)/);
  if (sentenceEnd?.index !== undefined) {
    return searchFloor + sentenceEnd.index + sentenceEnd[0].length;
  }

  const lastWhitespace = window.lastIndexOf(' ');
  if (lastWhitespace !== -1) {
    return searchFloor + lastWhitespace + 1;
  }

  return tentativeEnd;
}
