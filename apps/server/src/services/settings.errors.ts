import type { SettingsErrorCode } from '@freebuff/contracts';
import { DomainError } from './errors.js';

/** Controlled error thrown by the settings service. */
export class SettingsError extends DomainError {
  override readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = 'SettingsError';
    this.code = code;
  }
}
