import { HttpException } from '@nestjs/common';
import { DomainError } from '../core/domain/errors.js';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const HTTP_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'rate_limited',
};

/** Maps any thrown error to `{ error: { code, message, details? } }`. Never leaks stacks or internals. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof DomainError) {
    const error: ErrorBody['error'] = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    return { status: err.httpStatus, body: { error } };
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const response = err.getResponse();
    const message =
      typeof response === 'object' && response !== null && 'message' in response
        ? String((response as { message: unknown }).message)
        : err.message;
    return { status, body: { error: { code: HTTP_CODES[status] ?? 'http_error', message } } };
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // body-parser errors (invalid JSON, payload too large) carry a 4xx `status`.
    const message = status === 413 ? 'Request body too large' : 'Request body is not valid JSON';
    return { status, body: { error: { code: HTTP_CODES[status] ?? 'bad_request', message } } };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } } };
}
