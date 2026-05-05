import { describe, it, expect } from 'vitest';
import { COMPONENT_TYPES } from '../lib/types.js';

describe('COMPONENT_TYPES', () => {
  it('includes outfit', () => {
    expect(COMPONENT_TYPES).toContain('outfit');
  });
  it('includes cut', () => {
    expect(COMPONENT_TYPES).toContain('cut');
  });
});
