import type { FastifyReply } from 'fastify';
import type { ApiErrorResponse } from '@freebuff/contracts';
import { DatabaseError } from '../core/database/helpers/errors.js';
import { DomainError } from '../services/errors.js';

const GENERIC_MESSAGE = 'خطای غیرمنتظره رخ داد. دوباره تلاش کنید.';

/**
 * Map a thrown error to a typed, client-safe response. Internal details are
 * logged by the caller, never returned to the client.
 */
export function toErrorResponse(reply: FastifyReply, error: unknown): ApiErrorResponse {
  if (error instanceof DomainError) {
    const status = error.code === 'DATABASE_ERROR' ? 500 : 400;
    reply.code(status);
    return { error: { code: error.code, message: error.message } };
  }
  if (error instanceof DatabaseError) {
    reply.code(500);
    return { error: { code: 'DATABASE_ERROR', message: 'خطا در دسترسی به Database. دوباره تلاش کنید.' } };
  }
  reply.code(500);
  return { error: { code: 'DATABASE_ERROR', message: GENERIC_MESSAGE } };
}
