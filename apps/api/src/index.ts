// Polyfill global WebSocket for @supabase/realtime-js on Node < 22.
// Must run before any Supabase client is constructed.
import WebSocket from 'ws';
(globalThis as unknown as { WebSocket?: unknown }).WebSocket ??= WebSocket;

import { serve } from '@hono/node-server';
import { loadEnv } from '@wgc/config';
import { createApp } from './app.js';
import { logger } from './logger.js';

const env = loadEnv();
const app = createApp();

serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  logger.info({ port: info.port, env: env.WGC_NODE_ENV }, 'WGC API listening');
});
