export interface WorldRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sent as the Idempotency-Key header; stable across retries and crash resumes of the same step. */
  idempotencyKey?: string;
  timeoutMs: number;
}

export interface WorldResponse {
  status: number;
  body: unknown;
}

/**
 * Outbound HTTP port (mock world and any allowed endpoint). Network failures and timeouts
 * must be thrown as TransientError; HTTP error statuses are returned, not thrown.
 */
export interface WorldClient {
  request(req: WorldRequest): Promise<WorldResponse>;
}
