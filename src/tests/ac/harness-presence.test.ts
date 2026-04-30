import { describe, it, expect } from 'vitest';
import { getHarnessPresence } from '../../lib/ac/harness-presence.js';

describe('getHarnessPresence', () => {
  it('returns one entry per requested harness', () => {
    const result = getHarnessPresence(['claude-code', 'codex'], {
      whichBin: () => '/fake/path',
    });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.harness)).toEqual(['claude-code', 'codex']);
  });

  it('marks found=true when whichBin returns a path', () => {
    const result = getHarnessPresence(['claude-code'], {
      whichBin: (bin) => (bin === 'claude' ? '/usr/local/bin/claude' : null),
    });
    expect(result[0]?.found).toBe(true);
    expect(result[0]?.binPath).toBe('/usr/local/bin/claude');
  });

  it('marks found=false when whichBin returns null', () => {
    const result = getHarnessPresence(['copilot'], { whichBin: () => null });
    expect(result[0]?.found).toBe(false);
    expect(result[0]?.binPath).toBeUndefined();
  });

  it('maps harness names to bin names correctly', () => {
    const calls: string[] = [];
    getHarnessPresence(['claude-code', 'apm', 'codex', 'gemini', 'copilot', 'pi'], {
      whichBin: (bin) => {
        calls.push(bin);
        return null;
      },
    });
    expect(calls).toEqual(['claude', 'apm', 'codex', 'gemini', 'copilot', 'pi']);
  });
});
