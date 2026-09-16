import mammoth from 'mammoth';
import { ExtractionResult } from './pdf-extractor';

export async function extractDocxText(buffer: Buffer): Promise<ExtractionResult> {
  const result = await mammoth.extractRawText({ buffer });
  // DOCX has no fixed pagination without a rendering engine — page count is unavailable.
  return { text: result.value, pageCount: null };
}
