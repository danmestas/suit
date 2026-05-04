/**
 * Derive a one-paragraph contextual blurb from an outfit/mode/accessory body.
 *
 * Picker rows and `suit list -v` show the blurb as a sub-line under the
 * `description:` field. The blurb gives the user enough context to choose
 * without opening the file. The full body remains visible via `suit show`.
 *
 * Algorithm:
 *   1. Skip a leading `# Heading` H1 (and any blank lines before/after it).
 *   2. Take everything up to the first blank line (paragraph boundary).
 *   3. Collapse intra-paragraph newlines to spaces; trim.
 *   4. If empty (body was only headings, or fully blank), return `fallback`.
 *   5. If longer than 280 chars, truncate to 279 and append `…`.
 */
export function extractBlurb(body: string, fallback: string): string {
  const MAX = 280;
  const lines = body.split(/\r?\n/);

  // Skip leading blank lines.
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;

  // Skip a single leading H1 (`# Title`) if present, plus the blank lines after it.
  if (i < lines.length && /^#\s+\S/.test(lines[i]!)) {
    i++;
    while (i < lines.length && lines[i]!.trim() === '') i++;
  }

  // Collect the first paragraph: contiguous non-blank lines.
  const paraLines: string[] = [];
  while (i < lines.length && lines[i]!.trim() !== '') {
    const line = lines[i]!;
    // If the first paragraph is itself a heading (e.g. `## Section`), skip
    // past it and try the next paragraph — headings are not blurbs.
    if (paraLines.length === 0 && /^#{1,6}\s+\S/.test(line)) {
      // Skip this heading line plus following blank lines, then continue.
      i++;
      while (i < lines.length && lines[i]!.trim() === '') i++;
      continue;
    }
    paraLines.push(line);
    i++;
  }

  const collapsed = paraLines.join(' ').replace(/\s+/g, ' ').trim();
  if (collapsed === '') return fallback;
  if (collapsed.length <= MAX) return collapsed;
  return collapsed.slice(0, MAX - 1).trimEnd() + '…';
}
