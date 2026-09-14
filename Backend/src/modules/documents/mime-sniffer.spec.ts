import { sniffMimeType } from './mime-sniffer';

describe('sniffMimeType', () => {
  it('identifies a PDF by its magic bytes', () => {
    const buffer = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('rest of a fake pdf')]);
    expect(sniffMimeType(buffer)).toBe('application/pdf');
  });

  it('identifies a DOCX (ZIP container) by its magic bytes', () => {
    const buffer = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('rest of a fake zip'),
    ]);
    expect(sniffMimeType(buffer)).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('returns null for unrecognized content, regardless of what it claims to be', () => {
    const buffer = Buffer.from('just some plain text, not a real document');
    expect(sniffMimeType(buffer)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
  });
});
