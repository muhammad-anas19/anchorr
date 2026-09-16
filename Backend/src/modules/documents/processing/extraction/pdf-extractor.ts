import pdfParse from 'pdf-parse';

export interface ExtractionResult {
  text: string;
  pageCount: number | null;
}

export async function extractPdfText(buffer: Buffer): Promise<ExtractionResult> {
  const result = await pdfParse(buffer);
  return { text: result.text, pageCount: result.numpages };
}
