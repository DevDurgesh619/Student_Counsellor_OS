import { describe, it, expect } from 'vitest';
import { Cron } from 'croner';
import { SCHEDULERS } from './schedulers.js';

describe('SCHEDULERS', () => {
  it('all entries parse as valid cron + IANA timezone', () => {
    for (const entry of SCHEDULERS) {
      expect(entry.timezone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
      expect(() => new Cron(entry.schedule, { timezone: entry.timezone })).not.toThrow();
    }
  });

  it('every entry carries a description (CLAUDE_CODE.md §11 explicitness rule)', () => {
    for (const entry of SCHEDULERS) {
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });

  it('names are unique', () => {
    const names = SCHEDULERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
