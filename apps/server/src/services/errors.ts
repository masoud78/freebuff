import type { ApiErrorCode } from '@freebuff/contracts';

/**
 * Base class for controlled domain errors. `code` maps to a stable API error
 * code; `message` is user-facing (Persian) and safe to expose to clients.
 */
export class DomainError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
  }
}
