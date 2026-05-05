import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverComponents } from '../lib/discover.ts';

const FIXTURES_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  '../fixtures/discover',
);

describe('discoverComponents', () => {
  it('finds SKILL.md under skills/, plugins/, rules/', async () => {
    const components = await discoverComponents(FIXTURES_ROOT);
    const names = components.map((c) => c.manifest.name).sort();
    expect(names).toEqual(['sample-rule', 'sample-skill']);
  });

  it('parses frontmatter into manifest', async () => {
    const components = await discoverComponents(FIXTURES_ROOT);
    const skill = components.find((c) => c.manifest.name === 'sample-skill');
    expect(skill?.manifest.type).toBe('skill');
    expect(skill?.manifest.targets).toEqual(['claude-code', 'apm']);
    expect(skill?.body.trim().startsWith('# Sample Skill')).toBe(true);
  });

  it('records relativeDir from repo root', async () => {
    const components = await discoverComponents(FIXTURES_ROOT);
    const skill = components.find((c) => c.manifest.name === 'sample-skill');
    expect(skill?.relativeDir).toBe('skills/sample-skill');
  });

  it('surfaces the offending file path when frontmatter is invalid', async () => {
    const BAD_ROOT = path.resolve(fileURLToPath(import.meta.url), '../fixtures/discover-invalid');
    await expect(discoverComponents(BAD_ROOT)).rejects.toThrow(/skills\/bad\/SKILL\.md/);
  });

  it('finds outfits under outfits/', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-'));
    await fs.mkdir(path.join(tmp, 'outfits', 'test-outfit'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'outfits', 'test-outfit', 'outfit.md'),
      `---
name: test-outfit
version: 1.0.0
type: outfit
description: t
targets: [claude-code]
categories: [tooling]
---

body
`,
    );
    const result = await discoverComponents(tmp);
    expect(result.find((c) => c.manifest.type === 'outfit' && c.manifest.name === 'test-outfit')).toBeDefined();
  });

  it('finds accessories under accessories/', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-'));
    await fs.mkdir(path.join(tmp, 'accessories', 'test-accessory'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'accessories', 'test-accessory', 'accessory.md'),
      `---
name: test-accessory
version: 1.0.0
type: accessory
description: t
targets: [claude-code]
include:
  skills: [some-skill]
---

body
`,
    );
    const result = await discoverComponents(tmp);
    expect(
      result.find((c) => c.manifest.type === 'accessory' && c.manifest.name === 'test-accessory'),
    ).toBeDefined();
  });

  it('finds AGENT.md under agents/', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-'));
    await fs.mkdir(path.join(tmp, 'agents', 'test-agent'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'agents', 'test-agent', 'AGENT.md'),
      `---
name: test-agent
version: 1.0.0
type: agent
description: t
targets: [claude-code]
---

body
`,
    );
    const result = await discoverComponents(tmp);
    expect(result.find((c) => c.manifest.type === 'agent' && c.manifest.name === 'test-agent')).toBeDefined();
  });

  it('finds HOOK.md under hooks/', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-'));
    await fs.mkdir(path.join(tmp, 'hooks', 'test-hook'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'hooks', 'test-hook', 'HOOK.md'),
      `---
name: test-hook
version: 1.0.0
type: hook
description: t
targets: [claude-code]
---

body
`,
    );
    const result = await discoverComponents(tmp);
    expect(result.find((c) => c.manifest.type === 'hook' && c.manifest.name === 'test-hook')).toBeDefined();
  });

  it('finds RULES.md under rules/', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-'));
    await fs.mkdir(path.join(tmp, 'rules', 'test-rules'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'rules', 'test-rules', 'RULES.md'),
      `---
name: test-rules
version: 1.0.0
type: rules
description: t
targets: [claude-code]
---

body
`,
    );
    const result = await discoverComponents(tmp);
    expect(result.find((c) => c.manifest.type === 'rules' && c.manifest.name === 'test-rules')).toBeDefined();
  });

  it('falls back to SKILL.md inside agents/hooks/commands/rules for back-compat', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-'));
    // Use the legacy SKILL.md filename inside an agents/ entry
    await fs.mkdir(path.join(tmp, 'agents', 'legacy-agent'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'agents', 'legacy-agent', 'SKILL.md'),
      `---
name: legacy-agent
version: 1.0.0
type: agent
description: t
targets: [claude-code]
---

body
`,
    );
    const result = await discoverComponents(tmp);
    expect(result.find((c) => c.manifest.name === 'legacy-agent')).toBeDefined();
  });

  it('finds cuts under cuts/', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-'));
    await fs.mkdir(path.join(tmp, 'cuts', 'test-cut'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'cuts', 'test-cut', 'cut.md'),
      `---
name: test-cut
version: 1.0.0
type: cut
description: t
targets: [claude-code]
categories: [tooling]
---

You are in test cut.
`,
    );
    const result = await discoverComponents(tmp);
    expect(result.find((c) => c.manifest.type === 'cut' && c.manifest.name === 'test-cut')).toBeDefined();
  });
});
