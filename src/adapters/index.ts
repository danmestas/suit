import type { Adapter, Target } from '../lib/types.js';
import { apmAdapter } from './apm.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { geminiAdapter } from './gemini.js';
import { piAdapter } from './pi.js';

const REGISTRY: Partial<Record<Target, Adapter>> = {
  'claude-code': claudeCodeAdapter,
  apm: apmAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
  gemini: geminiAdapter,
  pi: piAdapter,
};

export function getAdapter(target: Target): Adapter | undefined {
  return REGISTRY[target];
}

export function listImplementedTargets(): Target[] {
  return Object.keys(REGISTRY) as Target[];
}
