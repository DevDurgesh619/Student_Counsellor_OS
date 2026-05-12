import { describe, expect, it, beforeEach } from 'vitest';
import { loadEnv } from './env.js';

describe('loadEnv', () => {
  beforeEach(() => {
    // reset module-level cache between tests by re-importing
  });

  it('accepts a minimal env with only defaults', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.WGC_LOG_LEVEL).toBe('info');
    expect(env.API_PORT).toBe(8787);
    expect(env.WGC_POSTMARK_FROM_DOMAIN).toBe('reports.wgc.in');
  });

  it('rejects invalid log level', () => {
    expect(() => loadEnv({ WGC_LOG_LEVEL: 'verbose' } as NodeJS.ProcessEnv)).toThrow(
      /WGC_LOG_LEVEL/,
    );
  });

  it('coerces API_PORT from string', () => {
    const env = loadEnv({ API_PORT: '9090' } as NodeJS.ProcessEnv);
    expect(env.API_PORT).toBe(9090);
  });
});
