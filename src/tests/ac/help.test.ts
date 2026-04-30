import { describe, it, expect } from 'vitest';
import { helpText } from '../../lib/ac/help.js';

describe('helpText', () => {
  it('mentions all subcommands', () => {
    const t = helpText();
    expect(t).toContain('init');
    expect(t).toContain('sync');
    expect(t).toContain('status');
    expect(t).toContain('doctor');
    expect(t).toContain('list');
    expect(t).toContain('show');
  });

  it('documents SUIT_CONTENT_PATH env var', () => {
    expect(helpText()).toContain('SUIT_CONTENT_PATH');
  });

  it('shows at least one example', () => {
    const t = helpText();
    expect(t).toMatch(/EXAMPLES|examples/i);
    expect(t).toMatch(/suit\s+claude/);
  });
});
