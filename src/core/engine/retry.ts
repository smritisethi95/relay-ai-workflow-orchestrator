import { PermanentError, TransientError, type StepError } from '../domain/errors.js';

/** 408, 429 and 5xx are worth retrying; any other non-2xx status is a permanent failure (fail fast). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function errorForStatus(status: number, body: unknown, what: string): StepError {
  const detail =
    typeof body === 'object' && body !== null && typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
      ? (body as { error: { message: string } }).error.message
      : typeof body === 'string' && body.length > 0
        ? body.slice(0, 200)
        : '';
  const message = `${what} returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
  return isRetryableStatus(status) ? new TransientError('http_error', message, status) : new PermanentError('http_error', message, status);
}

/** Exponential backoff with ±20 % jitter: base·2^(attempt-1), capped at `maxMs`. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.8 + 0.4 * random()));
}
