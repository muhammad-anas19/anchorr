import { extractPdfText, ExtractionResult } from './pdf-extractor';
import { extractDocxText } from './docx-extractor';

export { ExtractionResult };

const EXTRACTION_TIMEOUT_MS = 30_000;
const MIN_MEANINGFUL_TEXT_LENGTH = 40;

export class UnsupportedMimeTypeError extends Error {}
export class ExtractionTimeoutError extends Error {}

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function extractText(buffer: Buffer, mimeType: string): Promise<ExtractionResult> {
  const extractor = pickExtractor(mimeType);
  return withTimeout(extractor(buffer), EXTRACTION_TIMEOUT_MS);
}

/** Deterministic emptiness check — this is what routes a scanned PDF to a clean,
 *  non-retried "failed" outcome instead of a thrown error (see Phase 5 design). */
export function isEffectivelyEmpty(text: string): boolean {
  return text.trim().length < MIN_MEANINGFUL_TEXT_LENGTH;
}

function pickExtractor(mimeType: string): (buffer: Buffer) => Promise<ExtractionResult> {
  if (mimeType === 'application/pdf') {
    return extractPdfText;
  }
  if (mimeType === DOCX_MIME_TYPE) {
    return extractDocxText;
  }
  throw new UnsupportedMimeTypeError(`No extractor registered for mime type: ${mimeType}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExtractionTimeoutError(`Extraction exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
