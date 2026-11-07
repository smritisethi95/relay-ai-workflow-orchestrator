import { PermanentError } from '../domain/errors.js';
import { errorForStatus } from '../engine/retry.js';
import { assertUrlAllowed } from '../guardrails/url-allowlist.js';
import type { NodeHandler } from './types.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

export const httpRequestHandler: NodeHandler = {
  async execute({ node, params, idempotencyKey, world, settings }) {
    const method = params.method;
    if (typeof method !== 'string' || !METHODS.has(method)) {
      throw new PermanentError('invalid_param', `http_request '${node.id}' has unsupported method '${String(method)}'`);
    }
    const url = assertUrlAllowed(String(params.url), settings.allowedHttpHosts);

    const headers: Record<string, string> = {};
    if (params.headers !== undefined) {
      if (params.headers === null || typeof params.headers !== 'object' || Array.isArray(params.headers)) {
        throw new PermanentError('invalid_param', `http_request '${node.id}' headers must be an object`);
      }
      for (const [k, v] of Object.entries(params.headers)) {
        // The engine owns the idempotency key; a definition cannot override it.
        if (k.toLowerCase() !== 'idempotency-key') headers[k] = String(v);
      }
    }

    const res = await world.request({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: url.toString(),
      headers,
      body: method === 'GET' ? undefined : params.body,
      idempotencyKey,
      timeoutMs: settings.httpTimeoutMs,
    });
    if (res.status < 200 || res.status >= 300) throw errorForStatus(res.status, res.body, `${method} ${url.pathname}`);
    return { kind: 'completed', output: { status: res.status, body: res.body } };
  },
};
