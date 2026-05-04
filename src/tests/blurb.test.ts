import { describe, it, expect } from 'vitest';
import { extractBlurb } from '../lib/blurb.ts';

describe('extractBlurb', () => {
  it('strips a leading H1 and returns the next paragraph', () => {
    const body = `# Backend\n\nFor sessions focused on Go, server-side, infra, observability, debugging.\n\nMore stuff later.\n`;
    expect(extractBlurb(body, 'fb')).toBe(
      'For sessions focused on Go, server-side, infra, observability, debugging.',
    );
  });

  it('returns the first paragraph when there is no leading H1', () => {
    const body = `First paragraph here.\nSecond line of same paragraph.\n\nNext paragraph.\n`;
    expect(extractBlurb(body, 'fb')).toBe('First paragraph here. Second line of same paragraph.');
  });

  it('returns fallback when body is empty', () => {
    expect(extractBlurb('', 'description fallback')).toBe('description fallback');
    expect(extractBlurb('   \n  \n', 'description fallback')).toBe('description fallback');
  });

  it('returns fallback when body is only headings', () => {
    const body = `# Title\n\n## Subhead\n\n### Another\n`;
    expect(extractBlurb(body, 'fb')).toBe('fb');
  });

  it('skips a leading H1 then a sub-heading and returns the paragraph after', () => {
    const body = `# Title\n\n## Section\n\nReal first paragraph content.\n`;
    expect(extractBlurb(body, 'fb')).toBe('Real first paragraph content.');
  });

  it('truncates at 280 chars with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const body = `# T\n\n${long}\n`;
    const out = extractBlurb(body, 'fb');
    expect(out.length).toBe(280);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, 279)).toBe('x'.repeat(279));
  });

  it('does not truncate when paragraph is exactly 280 chars', () => {
    const exact = 'a'.repeat(280);
    expect(extractBlurb(exact, 'fb')).toBe(exact);
  });

  it('collapses intra-paragraph newlines and whitespace', () => {
    const body = `Line one.\nLine two.\nLine    three with   spaces.\n\nNext.`;
    expect(extractBlurb(body, 'fb')).toBe('Line one. Line two. Line three with spaces.');
  });

  it('handles CRLF line endings', () => {
    const body = `# Title\r\n\r\nParagraph here.\r\n`;
    expect(extractBlurb(body, 'fb')).toBe('Paragraph here.');
  });
});
