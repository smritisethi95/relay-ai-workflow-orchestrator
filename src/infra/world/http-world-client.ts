import { TransientError } from '../../core/domain/errors.js';
import type { WorldClient, WorldRequest, WorldResponse } from '../../core/ports/world-client.js';

/** fetch-based client: hard timeout per call, no redirects (SSRF), Idempotency-Key always set by the engine. */
export class HttpWorldClient implements WorldClient {
  async request(req: WorldRequest): Promise<WorldResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;

    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new TransientError('timeout', `${req.method} ${new URL(req.url).pathname} timed out after ${req.timeoutMs} ms`);
      }
      throw new TransientError('network_error', `${req.method} ${new URL(req.url).pathname} failed: ${(err as Error).message}`);
    }

    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON bodies are returned as text
      }
    }
    return { status: res.status, body };
  }
}
