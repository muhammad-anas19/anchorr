import { chunkText } from './chunking';

describe('chunkText', () => {
  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('returns a single chunk for text shorter than the target chunk size', () => {
    const text = 'A short document about refund policy.';
    const chunks = chunkText(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].charEnd).toBe(text.length);
  });

  it("every chunk's content is exactly what its charStart/charEnd slice out of the original text", () => {
    const text = 'word '.repeat(500); // 2500 chars, well over the target size, no natural boundaries
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });

  it('produces overlapping chunks that together cover the entire text with no gaps', () => {
    const text = 'word '.repeat(500).trimEnd(); // avoid the trailing-whitespace trim shifting the expected end
    const chunks = chunkText(text);

    expect(chunks[0].charStart).toBe(0);
    expect(chunks[chunks.length - 1].charEnd).toBe(text.length);

    for (let i = 0; i < chunks.length - 1; i++) {
      // Overlap: the next chunk starts before the current one ends.
      expect(chunks[i + 1].charStart).toBeLessThan(chunks[i].charEnd);
      // No gap: the next chunk's start is not past where the current one ends.
      expect(chunks[i + 1].charStart).toBeLessThanOrEqual(chunks[i].charEnd);
    }
  });

  it('snaps a chunk boundary to a paragraph break near the target size instead of cutting mid-word', () => {
    const firstParagraph = 'Refunds are available within 30 days of purchase. '.repeat(19); // 950 chars
    const secondParagraph = 'Enterprise annual contracts are handled differently and are non-refundable.';
    const text = firstParagraph + '\n\n' + secondParagraph; // 1029 chars total, so it must actually split

    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content.endsWith('purchase. ')).toBe(true);
    expect(chunks[0].content).not.toContain('Enterprise');
  });

  it('still terminates and covers the full range for text with no whitespace at all', () => {
    const text = 'x'.repeat(3000);
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[chunks.length - 1].charEnd).toBe(text.length);
  });

  it('trims leading/trailing whitespace from the overall text before computing offsets', () => {
    const text = '   \n  Hello world.  \n  ';
    const chunks = chunkText(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Hello world.');
  });
});
