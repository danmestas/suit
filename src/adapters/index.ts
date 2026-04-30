import type { Adapter, Target } from '../lib/types';
import { apmAdapter } from './apm';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { copilotAdapter } from './copilot';
import { geminiAdapter } from './gemini';
import { piAdapter } from './pi';

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
