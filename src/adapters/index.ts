import type { Adapter, Target } from '../lib/types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { piAdapter } from './pi.js';

const REGISTRY: Partial<Record<Target, Adapter>> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  pi: piAdapter,
};

export function getAdapter(target: Target): Adapter | undefined {
  return REGISTRY[target];
}

export function listImplementedTargets(): Target[] {
  return Object.keys(REGISTRY) as Target[];
}
