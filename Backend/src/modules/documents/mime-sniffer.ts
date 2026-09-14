export type SupportedMimeType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PDF_SIGNATURE = Buffer.from('%PDF');
// DOCX is a ZIP container; this checks the ZIP signature only, not the contents.
// A rigorous check would also confirm the archive contains word/document.xml —
// deferred as unnecessary complexity while PDF/DOCX are the only two accepted types.
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function sniffMimeType(buffer: Buffer): SupportedMimeType | null {
  if (buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    return 'application/pdf';
  }
  if (buffer.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return null;
}
