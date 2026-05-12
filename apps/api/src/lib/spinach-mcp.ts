import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type OAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { counsellors, db, decryptJson, encryptJson } from '@wgc/db';
import { loadEnv } from '@wgc/config';
import { logger } from '../logger.js';

/**
 * Thin Spinach MCP client wrapper.
 *
 * Spinach exposes their meeting data via an MCP server at
 * https://mcp.spinach.ai/mcp (per-user OAuth, OAuth 2.1 + PKCE +
 * dynamic client registration per the MCP authorization spec).
 *
 * We don't use the SDK's `OAuthClientProvider` indirection because our
 * flow spans two HTTP requests (setup-url → /auth/spinach/callback)
 * with persistent storage in Postgres. Instead we call the SDK's
 * lower-level helpers directly (`startAuthorization`,
 * `exchangeAuthorization`, `refreshAuthorization`) and manage
 * token persistence ourselves through `counsellors.spinach_oauth_token`.
 */

const PROCESS_CACHE: {
  serverInfo: OAuthServerInfo | null;
  clientInfo: OAuthClientInformationFull | null;
} = { serverInfo: null, clientInfo: null };

export class SpinachReauthRequired extends Error {
  constructor(public readonly counsellorId: string, message = 'Spinach token invalid; reauth needed') {
    super(message);
    this.name = 'SpinachReauthRequired';
  }
}

type StoredEnvelope =
  | { pending: { state: string; codeVerifier: string } }
  | { tokens: OAuthTokens; clientInfo?: OAuthClientInformationFull }
  | null;

// ─── Discovery + client registration (cached at process level) ─────────────

async function getServerInfo(): Promise<OAuthServerInfo> {
  if (PROCESS_CACHE.serverInfo) return PROCESS_CACHE.serverInfo;
  const env = loadEnv();
  const info = await discoverOAuthServerInfo(env.WGC_SPINACH_MCP_URL);
  PROCESS_CACHE.serverInfo = info;
  return info;
}

async function getClientInfo(): Promise<OAuthClientInformationFull> {
  if (PROCESS_CACHE.clientInfo) return PROCESS_CACHE.clientInfo;
  const env = loadEnv();
  // Pre-registered client takes precedence (env vars).
  if (env.WGC_SPINACH_CLIENT_ID) {
    const info: OAuthClientInformationFull = {
      client_id: env.WGC_SPINACH_CLIENT_ID,
      client_secret: env.WGC_SPINACH_CLIENT_SECRET,
      redirect_uris: env.WGC_SPINACH_REDIRECT_URI
        ? [env.WGC_SPINACH_REDIRECT_URI]
        : [],
    };
    PROCESS_CACHE.clientInfo = info;
    return info;
  }
  // Otherwise, dynamic client registration against the Spinach OAuth server.
  if (!env.WGC_SPINACH_REDIRECT_URI) {
    throw new Error('WGC_SPINACH_REDIRECT_URI must be set');
  }
  const server = await getServerInfo();
  const registered = await registerClient(server.authorizationServerUrl, {
    metadata: server.authorizationServerMetadata,
    clientMetadata: {
      client_name: 'WGC Counsellor OS',
      redirect_uris: [env.WGC_SPINACH_REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  PROCESS_CACHE.clientInfo = registered;
  logger.info({ clientId: registered.client_id }, 'spinach mcp: dynamic client registered');
  return registered;
}

// ─── Auth flow ─────────────────────────────────────────────────────────────

/**
 * Start the OAuth dance for a given counsellor. Persists the PKCE verifier
 * + state on the counsellor row (transiently, until callback completes).
 * Returns the URL to redirect the user to.
 */
export async function startSpinachAuth(counsellorId: string): Promise<string> {
  const env = loadEnv();
  if (!env.WGC_SPINACH_REDIRECT_URI) {
    throw new Error('WGC_SPINACH_REDIRECT_URI not set');
  }
  const server = await getServerInfo();
  const clientInfo = await getClientInfo();
  const state = signedState(counsellorId);
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    server.authorizationServerUrl,
    {
      metadata: server.authorizationServerMetadata,
      clientInformation: clientInfo,
      redirectUrl: env.WGC_SPINACH_REDIRECT_URI,
      state,
    },
  );
  // Persist pending state UNENCRYPTED (it's transient and not sensitive
  // on its own; the verifier is single-use and useless without the auth code).
  const envelope: StoredEnvelope = { pending: { state, codeVerifier } };
  await db
    .update(counsellors)
    .set({ spinachOauthToken: envelope as unknown as Record<string, unknown> })
    .where(eq(counsellors.id, counsellorId));
  return authorizationUrl.toString();
}

/**
 * Called from the OAuth callback handler with the `code` + `state` from
 * Spinach. Exchanges the code for tokens and persists them encrypted.
 */
export async function completeSpinachAuth(state: string, code: string): Promise<string> {
  const counsellorId = verifyState(state);
  if (!counsellorId) throw new Error('invalid OAuth state');

  const env = loadEnv();
  if (!env.WGC_SPINACH_REDIRECT_URI) throw new Error('WGC_SPINACH_REDIRECT_URI not set');

  const row = (
    await db.select().from(counsellors).where(eq(counsellors.id, counsellorId)).limit(1)
  )[0];
  if (!row) throw new Error(`counsellor ${counsellorId} not found`);
  const pending = row.spinachOauthToken as { pending?: { state: string; codeVerifier: string } } | null;
  if (!pending?.pending?.codeVerifier) throw new Error('no pending OAuth verifier for counsellor');
  if (pending.pending.state !== state) throw new Error('state mismatch');

  const server = await getServerInfo();
  const clientInfo = await getClientInfo();
  const tokens = await exchangeAuthorization(server.authorizationServerUrl, {
    metadata: server.authorizationServerMetadata,
    clientInformation: clientInfo,
    authorizationCode: code,
    codeVerifier: pending.pending.codeVerifier,
    redirectUri: env.WGC_SPINACH_REDIRECT_URI,
  });

  const envelope = await encryptJson({ tokens, clientInfo, savedAt: Date.now() });
  await db
    .update(counsellors)
    .set({ spinachOauthToken: envelope as unknown as Record<string, unknown> })
    .where(eq(counsellors.id, counsellorId));

  return counsellorId;
}

export async function disconnectSpinach(counsellorId: string): Promise<void> {
  await db
    .update(counsellors)
    .set({ spinachOauthToken: null, spinachLastSyncedAt: null })
    .where(eq(counsellors.id, counsellorId));
}

// ─── Connecting + ensuring a valid access token ────────────────────────────

type LoadedTokens = {
  tokens: OAuthTokens;
  clientInfo?: OAuthClientInformationFull;
  savedAt?: number;
};

async function loadTokens(counsellorId: string): Promise<LoadedTokens> {
  const row = (
    await db
      .select({ token: counsellors.spinachOauthToken })
      .from(counsellors)
      .where(eq(counsellors.id, counsellorId))
      .limit(1)
  )[0];
  if (!row?.token) throw new SpinachReauthRequired(counsellorId, 'no Spinach token stored');
  if ('pending' in (row.token as Record<string, unknown>)) {
    throw new SpinachReauthRequired(counsellorId, 'Spinach OAuth flow was never completed');
  }
  const decrypted = await decryptJson<LoadedTokens>(row.token);
  if (!decrypted?.tokens?.access_token) {
    throw new SpinachReauthRequired(counsellorId, 'stored token shape invalid');
  }
  return decrypted;
}

async function getValidAccessToken(counsellorId: string): Promise<string> {
  const loaded = await loadTokens(counsellorId);
  const { tokens } = loaded;
  const expiresAt =
    tokens.expires_in && loaded.savedAt
      ? loaded.savedAt + tokens.expires_in * 1000
      : null;
  const expired = expiresAt !== null && Date.now() > expiresAt - 60_000;
  if (!expired) return tokens.access_token;

  if (!tokens.refresh_token) {
    throw new SpinachReauthRequired(counsellorId, 'access token expired and no refresh_token');
  }
  const server = await getServerInfo();
  const clientInfo = loaded.clientInfo ?? (await getClientInfo());
  try {
    const refreshed = await refreshAuthorization(server.authorizationServerUrl, {
      metadata: server.authorizationServerMetadata,
      clientInformation: clientInfo,
      refreshToken: tokens.refresh_token,
    });
    const envelope = await encryptJson({
      tokens: refreshed,
      clientInfo,
      savedAt: Date.now(),
    });
    await db
      .update(counsellors)
      .set({ spinachOauthToken: envelope as unknown as Record<string, unknown> })
      .where(eq(counsellors.id, counsellorId));
    return refreshed.access_token;
  } catch (err) {
    logger.warn({ err, counsellorId }, 'spinach refresh failed; clearing token');
    await db
      .update(counsellors)
      .set({ spinachOauthToken: null })
      .where(eq(counsellors.id, counsellorId));
    throw new SpinachReauthRequired(counsellorId, 'refresh failed');
  }
}

// ─── MCP client + tool helpers ─────────────────────────────────────────────

type ConnectedClient = {
  client: Client;
  close: () => Promise<void>;
};

async function openClient(counsellorId: string): Promise<ConnectedClient> {
  const env = loadEnv();
  const accessToken = await getValidAccessToken(counsellorId);
  const transport = new StreamableHTTPClientTransport(new URL(env.WGC_SPINACH_MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
  const client = new Client(
    { name: 'wgc-counsellor-os', version: '0.1.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => {});
    // Bubble 401-ish errors as reauth required.
    const status = (err as { status?: number }).status;
    if (status === 401) throw new SpinachReauthRequired(counsellorId, 'MCP connect 401');
    throw err;
  }
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

export type SpinachMeetingSummary = {
  id: string;
  title?: string;
  scheduledAt?: string;
  attendees: Array<{ name?: string; email?: string; internal?: boolean }>;
};

export type SpinachMeetingFull = SpinachMeetingSummary & {
  summary?: string;
  transcript?: string;
  actionItems?: unknown[];
  decisions?: unknown[];
  raw: Record<string, unknown>;
};

/**
 * Connect, list meetings updated since `since`, then close. Tool names and
 * argument shape are based on Spinach's published MCP capabilities; we adapt
 * if their schema differs by inspecting `listTools()` at connect time.
 */
export async function listMeetings(
  counsellorId: string,
  opts: { since?: Date | null } = {},
): Promise<SpinachMeetingSummary[]> {
  const { client, close } = await openClient(counsellorId);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    logger.info({ counsellorId, toolNames }, 'spinach: listTools result');
    const toolNameSet = new Set(toolNames);
    const args: Record<string, unknown> = {};
    if (opts.since) args['since'] = opts.since.toISOString();
    const toolName = pickTool(toolNameSet, ['list_meetings', 'meetings_list', 'search_meetings']);
    if (!toolName) {
      logger.warn({ counsellorId, toolNames }, 'spinach: no list_meetings-like tool');
      return [];
    }
    logger.info(
      { counsellorId, toolName, args },
      'spinach: calling list-meetings-like tool',
    );
    const res = await client.callTool({ name: toolName, arguments: args });
    debugLogToolResult('list_meetings', counsellorId, res);
    const meetings = parseMeetingList(res);
    logger.info(
      {
        counsellorId,
        count: meetings.length,
        firstIds: meetings.slice(0, 5).map((m) => m.id),
      },
      'spinach: parsed meetings list',
    );
    return meetings;
  } finally {
    await close();
  }
}

export async function pullFullMeeting(
  counsellorId: string,
  meetingId: string,
): Promise<SpinachMeetingFull | null> {
  const { client, close } = await openClient(counsellorId);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    const toolNameSet = new Set(toolNames);
    // Spinach exposes a generic `get` tool that resolves URI-style ids
    // (e.g. "meeting:<uuid>"). Prefer the dedicated pull tools if a vendor
    // ever ships one, but fall back to `get` which is what Spinach offers today.
    const toolName = pickTool(toolNameSet, [
      'pull_full_meeting',
      'pull_meeting',
      'get_meeting',
      'get_full_meeting',
      'get',
    ]);
    if (!toolName) {
      logger.warn({ counsellorId, toolNames }, 'spinach: no pull_meeting-like tool');
      return null;
    }
    const toolDef = tools.tools.find((t) => t.name === toolName);
    // Spinach's `get` accepts an `include` array; without it the call returns
    // an empty stub (we observed `{error, message, limit_per_*}`). Request
    // every field we use in ingestOneMeeting.
    const callArgs: Record<string, unknown> =
      toolName === 'get'
        ? {
            id: meetingId,
            include: [
              'summary',
              'transcript',
              'participants',
              'action_items',
              'decisions',
              'chapters',
              'metadata',
            ],
          }
        : { meeting_id: meetingId };
    logger.info(
      {
        counsellorId,
        toolName,
        meetingId,
        callArgs,
        inputSchema: toolDef?.inputSchema,
      },
      'spinach: calling pull-meeting tool',
    );
    const res = await client.callTool({ name: toolName, arguments: callArgs });
    debugLogToolResult(`pull_meeting:${meetingId}`, counsellorId, res);
    const parsed = parseMeetingFull(res, meetingId);
    if (parsed) {
      logger.info(
        {
          counsellorId,
          meetingId,
          title: parsed.title,
          scheduledAt: parsed.scheduledAt,
          attendeeCount: parsed.attendees.length,
          attendeeEmails: parsed.attendees.map((a) => a.email).filter(Boolean),
          summaryLen: parsed.summary?.length ?? 0,
          transcriptLen: parsed.transcript?.length ?? 0,
          actionItemCount: parsed.actionItems?.length ?? 0,
          rawKeys: Object.keys(parsed.raw),
        },
        'spinach: pull meeting parsed',
      );
    }
    return parsed;
  } finally {
    await close();
  }
}

// ─── Tool result parsing (lenient: Spinach's exact shape is undocumented) ──

function pickTool(available: Set<string>, candidates: string[]): string | null {
  for (const c of candidates) if (available.has(c)) return c;
  return null;
}

/**
 * Log enough of an MCP tool result that we can reverse-engineer Spinach's
 * response shape without flooding logs with full transcripts. Includes:
 *   - top-level keys of the response object
 *   - content-block types + text lengths
 *   - if the first text block is JSON: its top-level keys + length
 *   - the keys of the first meeting in the array (for list responses)
 */
function debugLogToolResult(tool: string, counsellorId: string, res: unknown): void {
  try {
    const r = res as Record<string, unknown>;
    const topKeys = Object.keys(r ?? {});
    const content = (r?.['content'] as Array<{ type: string; text?: string }>) ?? [];
    const contentSummary = content.map((b) => ({
      type: b.type,
      textLen: b.text?.length ?? 0,
    }));

    let parsedKeys: string[] | null = null;
    let parsedKind: string | null = null;
    let firstItemKeys: string[] | null = null;
    let parsedLen: number | null = null;
    for (const b of content) {
      if (b.type === 'text' && b.text) {
        try {
          const j = JSON.parse(b.text);
          if (Array.isArray(j)) {
            parsedKind = 'array';
            parsedLen = j.length;
            if (j.length > 0 && j[0] && typeof j[0] === 'object') {
              firstItemKeys = Object.keys(j[0] as Record<string, unknown>);
            }
          } else if (j && typeof j === 'object') {
            parsedKind = 'object';
            parsedKeys = Object.keys(j as Record<string, unknown>);
            const maybeArr =
              (j as { meetings?: unknown[]; results?: unknown[]; items?: unknown[] }).meetings ??
              (j as { results?: unknown[] }).results ??
              (j as { items?: unknown[] }).items;
            if (Array.isArray(maybeArr)) {
              parsedLen = maybeArr.length;
              if (maybeArr.length > 0 && maybeArr[0] && typeof maybeArr[0] === 'object') {
                firstItemKeys = Object.keys(maybeArr[0] as Record<string, unknown>);
              }
            }
          }
          break;
        } catch {
          // not JSON; ignore
        }
      }
    }

    logger.info(
      {
        counsellorId,
        tool,
        topKeys,
        contentSummary,
        parsedKind,
        parsedKeys,
        parsedLen,
        firstItemKeys,
      },
      'spinach: tool result shape',
    );
  } catch (err) {
    logger.warn({ err, counsellorId, tool }, 'spinach: failed to debug-log tool result');
  }
}

function extractJsonFromToolResult(res: unknown): unknown {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content;
  if (!content) return null;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      try {
        return JSON.parse(block.text);
      } catch {
        // not JSON; skip
      }
    }
  }
  // Some MCP servers also stuff structured data on a `structuredContent` field.
  const structured = (res as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) return structured;
  return null;
}

function parseMeetingList(res: unknown): SpinachMeetingSummary[] {
  const parsed = extractJsonFromToolResult(res);
  if (!parsed) return [];
  const arr =
    Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { meetings?: unknown[] }).meetings)
      ? (parsed as { meetings: unknown[] }).meetings
      : Array.isArray((parsed as { results?: unknown[] }).results)
      ? (parsed as { results: unknown[] }).results
      : [];
  return arr
    .map((m) => normaliseMeetingSummary(m))
    .filter((m): m is SpinachMeetingSummary => Boolean(m));
}

function parseMeetingFull(res: unknown, fallbackId: string): SpinachMeetingFull | null {
  const parsed = extractJsonFromToolResult(res);
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as Record<string, unknown>;
  const summary = normaliseMeetingSummary(m) ?? {
    id: fallbackId,
    attendees: [],
  };
  return {
    ...summary,
    summary: pickString(m, ['summary', 'summary_text', 'ai_summary']),
    transcript: pickString(m, ['transcript', 'transcript_text', 'full_transcript']),
    actionItems: (m['action_items'] as unknown[]) ?? (m['actionItems'] as unknown[]) ?? [],
    decisions: (m['decisions'] as unknown[]) ?? [],
    raw: m,
  };
}

function normaliseMeetingSummary(raw: unknown): SpinachMeetingSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id =
    pickString(m, ['id', 'meeting_id', 'spinach_meeting_id']) ?? null;
  if (!id) return null;
  const attendeesRaw =
    (m['attendees'] as unknown[]) ??
    (m['participants'] as unknown[]) ??
    [];
  const attendees: Array<{ name?: string; email?: string; internal?: boolean }> = [];
  for (const a of attendeesRaw) {
    if (!a || typeof a !== 'object') continue;
    const ar = a as Record<string, unknown>;
    const att: { name?: string; email?: string; internal?: boolean } = {};
    const name = pickString(ar, ['name', 'display_name', 'full_name']);
    const email = pickString(ar, ['email', 'email_address']);
    if (name) att.name = name;
    if (email) att.email = email.toLowerCase();
    if (typeof ar['internal'] === 'boolean') att.internal = ar['internal'] as boolean;
    attendees.push(att);
  }
  return {
    id,
    title: pickString(m, ['title', 'name', 'meeting_title']),
    scheduledAt: pickString(m, [
      'scheduled_at',
      'started_at',
      'meeting_started_at',
      'date',
      'start_time',
    ]),
    attendees,
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

// ─── Signed state for OAuth round-trip ─────────────────────────────────────

function stateSecret(): string {
  const env = loadEnv();
  const secret = env.WGC_INTERNAL_API_SECRET ?? env.WGC_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('WGC_INTERNAL_API_SECRET or WGC_TOKEN_ENCRYPTION_KEY required for OAuth state signing');
  }
  return secret;
}

function signedState(counsellorId: string): string {
  const nonce = crypto.randomBytes(8).toString('hex');
  const issuedAt = Date.now();
  const payload = `${counsellorId}.${issuedAt}.${nonce}`;
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyState(state: string): string | null {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 4) return null;
    const [counsellorId, issuedAtStr, nonce, sig] = parts as [string, string, string, string];
    const expected = crypto
      .createHmac('sha256', stateSecret())
      .update(`${counsellorId}.${issuedAtStr}.${nonce}`)
      .digest('hex');
    const provided = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (provided.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(provided, expectedBuf)) return null;
    // Reject if older than 15 min (OAuth callback should be near-instant).
    const issuedAt = Number(issuedAtStr);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > 15 * 60 * 1000) return null;
    return counsellorId;
  } catch {
    return null;
  }
}
