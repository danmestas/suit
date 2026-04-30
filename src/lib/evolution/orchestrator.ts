// src/lib/evolution/orchestrator.ts
import path from 'node:path';
import os from 'node:os';
import { loadSessionsSince } from './sessions.js';
import { detectPermissionPrompts } from './permissions.js';
import { detectStaleMemoryRefs } from './memory.js';
import { redact } from './redact.js';
import type { EvolutionReport, EvolveOptions, Finding } from './types.js';

export interface OrchestratorOptions extends EvolveOptions {
  /** Override default sessions dir (used by tests). */
  sessionsDir?: string;
  /** Override default memory dir (used by tests). */
  memoryDir?: string;
}

export async function runEvolution(opts: OrchestratorOptions): Promise<EvolutionReport> {
  const sessionsDir =
    opts.sessionsDir ?? path.join(os.homedir(), '.claude', 'projects', opts.project, 'sessions');
  const memoryDir =
    opts.memoryDir ?? path.join(os.homedir(), '.claude', 'projects', opts.project, 'memory');

  const since = new Date(Date.now() - opts.sinceMs);
  const sessions = await loadSessionsSince(sessionsDir, since);

  const findings: Finding[] = [];
  findings.push(...detectPermissionPrompts(sessions));
  findings.push(...(await detectStaleMemoryRefs(memoryDir, opts.repoRoot)));

  // Future: meta-scout signals + arcs go here. Skipped in v1 because the
  // upstream `evolution-engine` library publish is gated on a separate PR.

  // Redact every evidence string and diff.
  for (const f of findings) {
    f.evidence = f.evidence.map(redact);
    if (f.proposedDiff) f.proposedDiff.diff = redact(f.proposedDiff.diff);
  }

  // Dedupe by (patternType, proposedDiff.targetPath, proposedDiff.summary).
  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const f of findings) {
    const key = `${f.patternType}::${f.proposedDiff?.targetPath ?? ''}::${f.proposedDiff?.summary ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  const windowEnd = new Date();
  return {
    project: opts.project,
    windowStart: since,
    windowEnd,
    sessionsScanned: sessions.length,
    llmCostUsd: opts.noLlm ? 0 : 0, // updated when LLM-using detectors land
    findings: deduped,
  };
}
