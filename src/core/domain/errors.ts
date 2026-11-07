/** Error surfaced to API callers; `code` is stable and machine-readable. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Error raised while executing a node; `retryable` decides between backoff and failing the run. */
export abstract class StepError extends Error {
  abstract readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export class TransientError extends StepError {
  readonly retryable = true;
  override readonly name = 'TransientError';
}

export class PermanentError extends StepError {
  readonly retryable = false;
  override readonly name = 'PermanentError';
}
