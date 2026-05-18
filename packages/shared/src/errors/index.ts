import { z } from 'zod';

/**
 * Error envelope shape (CLAUDE_CODE.md §9). Every non-2xx API response
 * conforms to this structure. Codes follow `DOMAIN_REASON` pattern.
 */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'code must be SCREAMING_SNAKE_CASE'),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export class WgcError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(params: {
    code: string;
    message: string;
    status: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'WgcError';
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

// Convenience constructors for the codes most commonly thrown across services.
export const Errors = {
  authInvalidToken: (message = 'Authentication token is invalid or expired') =>
    new WgcError({ code: 'AUTH_INVALID_TOKEN', message, status: 401 }),
  authForbidden: (message = 'You do not have access to this resource') =>
    new WgcError({ code: 'AUTH_FORBIDDEN', message, status: 403 }),
  notFound: (resource: string, id?: string) =>
    new WgcError({
      code: `${resource.toUpperCase()}_NOT_FOUND`,
      message: id ? `${resource} ${id} not found` : `${resource} not found`,
      status: 404,
    }),
  validation: (message: string, details?: Record<string, unknown>) =>
    new WgcError({ code: 'VALIDATION_FAILED', message, status: 400, details }),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new WgcError({ code, message, status: 409, details }),
  internal: (
    message = 'An unexpected error occurred',
    cause?: unknown,
    details?: Record<string, unknown>,
  ) => new WgcError({ code: 'INTERNAL_ERROR', message, status: 500, cause, details }),
};
