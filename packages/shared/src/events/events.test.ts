import { describe, it, expect } from 'vitest';
import { EventTypeSchema, assertNoV2Prefix } from './index.js';

describe('events', () => {
  it('accepts canonical v1 event types', () => {
    expect(EventTypeSchema.parse('session.extraction.completed')).toBe(
      'session.extraction.completed',
    );
    expect(EventTypeSchema.parse('report.cron.triggered')).toBe('report.cron.triggered');
  });

  it('rejects suffix-encoded cadence variants (clarifications.md Q3)', () => {
    expect(() => EventTypeSchema.parse('report.cron.triggered.weekly')).toThrow();
  });

  it('rejects unknown event types', () => {
    expect(() => EventTypeSchema.parse('made.up.event')).toThrow();
  });
});

describe('assertNoV2Prefix', () => {
  it('rejects whatsapp.*', () => {
    expect(() => assertNoV2Prefix('whatsapp.message.received')).toThrow(/forbidden/);
  });
  it('rejects pattern_detector.*', () => {
    expect(() => assertNoV2Prefix('pattern_detector.score_drop')).toThrow(/forbidden/);
  });
  it('rejects pillar.*', () => {
    expect(() => assertNoV2Prefix('pillar.recomputed')).toThrow(/forbidden/);
  });
  it('allows v1 events through', () => {
    expect(() => assertNoV2Prefix('session.extraction.completed')).not.toThrow();
  });
});
