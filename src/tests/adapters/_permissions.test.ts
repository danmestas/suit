import { describe, expect, it } from 'vitest';
import { applyPassthroughPermissions } from '../../adapters/_permissions.ts';

describe('applyPassthroughPermissions', () => {
  it('returns destination unchanged when permissions is undefined', () => {
    const dest = { existing: 'value' };
    expect(applyPassthroughPermissions(undefined, 'claude-code', dest)).toEqual({
      existing: 'value',
    });
  });

  it('returns destination unchanged when target sub-block is missing', () => {
    const dest = { existing: 'value' };
    expect(
      applyPassthroughPermissions(
        { codex: { sandbox_mode: 'workspace-write' } },
        'claude-code',
        dest,
      ),
    ).toEqual({ existing: 'value' });
  });

  it('returns destination unchanged when target sub-block is empty object', () => {
    const dest = { existing: 'value' };
    expect(
      applyPassthroughPermissions({ 'claude-code': {} }, 'claude-code', dest),
    ).toEqual({ existing: 'value' });
  });

  it('deep-merges the target sub-block into the destination', () => {
    const dest = { permissions: { allow: ['Bash(git:*)'] } };
    const result = applyPassthroughPermissions(
      {
        'claude-code': {
          permissions: {
            allow: ['Bash(npm:*)'],
            deny: ['Bash(rm:*)'],
          },
        },
      },
      'claude-code',
      dest,
    );
    expect(result).toEqual({
      permissions: {
        allow: ['Bash(git:*)', 'Bash(npm:*)'],
        deny: ['Bash(rm:*)'],
      },
    });
  });

  it('does not mutate the destination object', () => {
    const dest = { existing: 'value' };
    applyPassthroughPermissions(
      { 'claude-code': { added: 'new' } },
      'claude-code',
      dest,
    );
    expect(dest).toEqual({ existing: 'value' });
  });

  it('routes by target — codex block does not apply when target is claude-code', () => {
    const dest = { foo: 1 };
    const result = applyPassthroughPermissions(
      {
        'claude-code': { added: 'claude-value' },
        codex: { added: 'codex-value' },
      },
      'codex',
      dest,
    );
    expect(result).toEqual({ foo: 1, added: 'codex-value' });
  });
});
