/**
 * Error thrown by the database layer, distinct from generic server errors.
 * Lets callers (startup, health route) handle database failures separately
 * without leaking internal details to the client.
 */
export class DatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseError';
  }
}
