import { describe, it, expect } from 'vitest';
import {
  isJsonMergeable,
  isTomlMergeable,
  isMergeable,
  mergeJsonBuffers,
  mergeTomlBuffers,
  mergeBuffers,
  deepMerge,
} from '../lib/merge.ts';

describe('isJsonMergeable', () => {
  it('treats .json paths as mergeable', () => {
    expect(isJsonMergeable('.claude/settings.fragment.json')).toBe(true);
    expect(isJsonMergeable('hooks.json')).toBe(true);
    expect(isJsonMergeable('.mcp.fragment.json')).toBe(true);
  });

  it('treats markdown and shell scripts as NOT mergeable', () => {
    expect(isJsonMergeable('.claude/CLAUDE.md')).toBe(false);
    expect(isJsonMergeable('AGENTS.md')).toBe(false);
    expect(isJsonMergeable('hooks/recall.sh')).toBe(false);
  });
});

describe('deepMerge', () => {
  it('concatenates arrays', () => {
    expect(deepMerge([1, 2], [3, 4])).toEqual([1, 2, 3, 4]);
  });

  it('merges objects by key', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('recurses on nested objects', () => {
    expect(
      deepMerge(
        { hooks: { Stop: ['a'] } },
        { hooks: { SessionStart: ['b'] } },
      ),
    ).toEqual({ hooks: { Stop: ['a'], SessionStart: ['b'] } });
  });

  it('concatenates arrays under the same nested key', () => {
    expect(
      deepMerge(
        { hooks: { Stop: [{ matcher: '*', cmd: 'a' }] } },
        { hooks: { Stop: [{ matcher: '*', cmd: 'b' }] } },
      ),
    ).toEqual({
      hooks: {
        Stop: [
          { matcher: '*', cmd: 'a' },
          { matcher: '*', cmd: 'b' },
        ],
      },
    });
  });

  it('second value wins for primitives', () => {
    expect(deepMerge('a', 'b')).toBe('b');
    expect(deepMerge(1, 2)).toBe(2);
  });
});

describe('isTomlMergeable / isMergeable', () => {
  it('treats .toml paths as mergeable', () => {
    expect(isTomlMergeable('codex.config.toml')).toBe(true);
    expect(isTomlMergeable('any/path/file.toml')).toBe(true);
  });

  it('isMergeable accepts both json and toml', () => {
    expect(isMergeable('settings.json')).toBe(true);
    expect(isMergeable('codex.config.toml')).toBe(true);
    expect(isMergeable('CLAUDE.md')).toBe(false);
    expect(isMergeable('hooks/recall.sh')).toBe(false);
  });
});

describe('mergeTomlBuffers — codex.config.toml case', () => {
  it('merges a mcp_servers block with a top-level permissions-flavored block', () => {
    const mcp = `[mcp_servers.signoz]\ncommand = "signoz-mcp"\n`;
    const perms = `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n`;
    const merged = mergeTomlBuffers(mcp, perms).toString('utf-8');
    expect(merged).toContain('approval_policy = "on-request"');
    expect(merged).toContain('sandbox_mode = "workspace-write"');
    expect(merged).toContain('[mcp_servers.signoz]');
    expect(merged).toContain('command = "signoz-mcp"');
  });

  it('concatenates arrays under nested tables', () => {
    const a = `[[rules.prefix_rules]]\nprefix = "git "\n`;
    const b = `[[rules.prefix_rules]]\nprefix = "npm "\n`;
    const merged = mergeTomlBuffers(a, b).toString('utf-8');
    expect(merged.match(/prefix = "git "/g)).toHaveLength(1);
    expect(merged.match(/prefix = "npm "/g)).toHaveLength(1);
  });
});

describe('mergeBuffers dispatcher', () => {
  it('uses JSON merger for .json paths', () => {
    const out = mergeBuffers('a.json', '{"x":1}', '{"y":2}');
    expect(out).not.toBeNull();
    expect(out!.toString('utf-8')).toBe('{\n  "x": 1,\n  "y": 2\n}\n');
  });

  it('uses TOML merger for .toml paths', () => {
    const out = mergeBuffers('a.toml', 'x = 1\n', 'y = 2\n');
    expect(out).not.toBeNull();
    const s = out!.toString('utf-8');
    expect(s).toContain('x = 1');
    expect(s).toContain('y = 2');
  });

  it('returns null for non-mergeable paths', () => {
    expect(mergeBuffers('CLAUDE.md', 'a', 'b')).toBeNull();
    expect(mergeBuffers('script.sh', 'a', 'b')).toBeNull();
  });
});

describe('mergeJsonBuffers — settings.fragment.json case', () => {
  it('merges two hook-style fragments emitted by different components', () => {
    // hooks/recall emits its SessionStart hook
    const recall = JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/recall.sh' }] },
        ],
      },
    });
    // hooks/trace emits its Stop hook
    const trace = JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/trace.sh' }] },
        ],
      },
    });

    const merged = JSON.parse(mergeJsonBuffers(recall, trace).toString('utf-8'));

    expect(Object.keys(merged.hooks).sort()).toEqual(['SessionStart', 'Stop']);
    expect(merged.hooks.SessionStart).toHaveLength(1);
    expect(merged.hooks.Stop).toHaveLength(1);
  });

  it('concatenates multiple entries on the same hook event', () => {
    const a = JSON.stringify({
      hooks: { Stop: [{ matcher: 'A', hooks: [{ command: 'a.sh' }] }] },
    });
    const b = JSON.stringify({
      hooks: { Stop: [{ matcher: 'B', hooks: [{ command: 'b.sh' }] }] },
    });

    const merged = JSON.parse(mergeJsonBuffers(a, b).toString('utf-8'));
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[0].matcher).toBe('A');
    expect(merged.hooks.Stop[1].matcher).toBe('B');
  });

  it('emits canonical 2-space JSON with trailing newline', () => {
    const out = mergeJsonBuffers('{"a":1}', '{"b":2}').toString('utf-8');
    expect(out).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });
});
