import { readFileSync } from 'fs';
import { join } from 'path';
import { extractDocxText } from './docx-extractor';

describe('extractDocxText', () => {
  it('extracts real text from a genuine DOCX and reports no page count', async () => {
    const buffer = readFileSync(join(__dirname, 'fixtures', 'sample.docx'));

    const result = await extractDocxText(buffer);

    expect(result.text).toContain('Hello World from a hand-built DOCX fixture.');
    expect(result.pageCount).toBeNull();
  });
});
