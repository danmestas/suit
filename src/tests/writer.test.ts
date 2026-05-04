import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TempdirWriter, ProjectWriter } from '../lib/writer.ts';

const cleanupQueue: string[] = [];
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const dir = cleanupQueue.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkProjectMock(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'writer-test-proj-'));
  cleanupQueue.push(dir);
  return dir;
}

describe('TempdirWriter', () => {
  it('creates a tempdir destination under the OS tempdir', async () => {
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    expect(w.destination.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(w.destination)).toMatch(/^ac-prelaunch-/);
    const stat = await fs.stat(w.destination);
    expect(stat.isDirectory()).toBe(true);
  });

  it('uses the supplied prefix when provided', async () => {
    const w = await TempdirWriter.create('writer-spec-');
    cleanupQueue.push(w.destination);
    expect(path.basename(w.destination)).toMatch(/^writer-spec-/);
  });

  it('writes a file at a relative path resolved against destination', async () => {
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    await w.write({ path: 'AGENTS.md', content: 'hello' });
    const target = path.join(w.destination, 'AGENTS.md');
    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  });

  it('creates parent directories for nested paths', async () => {
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    await w.write({ path: '.claude/skills/foo/SKILL.md', content: '# foo' });
    const body = await fs.readFile(path.join(w.destination, '.claude/skills/foo/SKILL.md'), 'utf8');
    expect(body).toBe('# foo');
  });

  it('honours the file mode when provided', async () => {
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    await w.write({ path: 'hook.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 });
    const stat = await fs.stat(path.join(w.destination, 'hook.sh'));
    // Mask to permission bits — file type bits dominate the upper portion.
    expect(stat.mode & 0o777).toBe(0o755);
  });

  it('overwrites an existing file (orchestrator owns refusal logic)', async () => {
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    await w.write({ path: 'a.txt', content: 'first' });
    await w.write({ path: 'a.txt', content: 'second' });
    expect(await fs.readFile(path.join(w.destination, 'a.txt'), 'utf8')).toBe('second');
  });

  it('writes empty content', async () => {
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    await w.write({ path: 'empty.txt', content: '' });
    expect(await fs.readFile(path.join(w.destination, 'empty.txt'), 'utf8')).toBe('');
  });

  it('symlinks an external source into the destination', async () => {
    const sourceDir = await mkProjectMock();
    const sourceFile = path.join(sourceDir, 'src.txt');
    await fs.writeFile(sourceFile, 'pointed-to');
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    await w.symlink(sourceFile, 'linked.txt');
    const target = path.join(w.destination, 'linked.txt');
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('pointed-to');
  });

  it('symlink replaces an existing entry at the destination', async () => {
    const sourceDir = await mkProjectMock();
    const sourceFile = path.join(sourceDir, 'src.txt');
    await fs.writeFile(sourceFile, 'replacement');
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    await w.write({ path: 'collide', content: 'original' });
    await w.symlink(sourceFile, 'collide');
    const stat = await fs.lstat(path.join(w.destination, 'collide'));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(w.destination, 'collide'), 'utf8')).toBe('replacement');
  });

  it('cleanup deletes the tempdir', async () => {
    const w = await TempdirWriter.create();
    const dir = w.destination;
    await w.write({ path: 'x.txt', content: 'y' });
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    await w.cleanup!();
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects paths that escape the destination', async () => {
    const w = await TempdirWriter.create();
    cleanupQueue.push(w.destination);
    await expect(w.write({ path: '../escape.txt', content: 'no' })).rejects.toThrow(/escapes destination/);
  });
});

describe('ProjectWriter', () => {
  it('writes into the supplied project root with no cleanup hook', async () => {
    const proj = await mkProjectMock();
    const w = new ProjectWriter(proj);
    expect(w.destination).toBe(path.resolve(proj));
    expect(w.cleanup).toBeUndefined();
    await w.write({ path: '.claude/CLAUDE.md', content: '# project' });
    expect(await fs.readFile(path.join(proj, '.claude/CLAUDE.md'), 'utf8')).toBe('# project');
  });

  it('overwrites existing project content', async () => {
    const proj = await mkProjectMock();
    await fs.writeFile(path.join(proj, 'a.txt'), 'old');
    const w = new ProjectWriter(proj);
    await w.write({ path: 'a.txt', content: 'new' });
    expect(await fs.readFile(path.join(proj, 'a.txt'), 'utf8')).toBe('new');
  });

  it('symlinks files into the project root', async () => {
    const proj = await mkProjectMock();
    const sourceDir = await mkProjectMock();
    const sourceFile = path.join(sourceDir, 'src.md');
    await fs.writeFile(sourceFile, 'shared');
    const w = new ProjectWriter(proj);
    await w.symlink(sourceFile, 'linked.md');
    const stat = await fs.lstat(path.join(proj, 'linked.md'));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(proj, 'linked.md'), 'utf8')).toBe('shared');
  });

  it('relative EmittedFile.path resolves against destination', async () => {
    const proj = await mkProjectMock();
    const w = new ProjectWriter(proj);
    await w.write({ path: 'nested/deep/file.txt', content: 'x' });
    expect(await fs.readFile(path.join(proj, 'nested/deep/file.txt'), 'utf8')).toBe('x');
  });

  it('rejects paths that escape the project root', async () => {
    const proj = await mkProjectMock();
    const w = new ProjectWriter(proj);
    await expect(w.write({ path: '../outside.txt', content: 'no' })).rejects.toThrow(/escapes destination/);
  });

  it('writes empty content', async () => {
    const proj = await mkProjectMock();
    const w = new ProjectWriter(proj);
    await w.write({ path: 'empty', content: '' });
    expect(await fs.readFile(path.join(proj, 'empty'), 'utf8')).toBe('');
  });
});
