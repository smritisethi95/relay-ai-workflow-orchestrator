import { TransientError } from '../../src/core/domain/errors.js';
import type { WorldClient, WorldRequest, WorldResponse } from '../../src/core/ports/world-client.js';

export interface WorldCall {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey?: string;
  replayed: boolean;
  status: number;
}

type Scripted = number | 'timeout';

/** In-process stand-in for scripts/mock_world.py: same routes, same idempotency replay, scriptable failures. */
export class FakeWorld implements WorldClient {
  readonly calls: WorldCall[] = [];
  private readonly cache = new Map<string, WorldResponse>();
  private readonly scripted = new Map<string, Scripted[]>();
  private seq = 0;
  readonly orders: Record<string, { status: string; amount_usd: number }> = {
    ord_2001: { status: 'processing', amount_usd: 89 },
    ord_2002: { status: 'delivered', amount_usd: 45.5 },
    ord_2003: { status: 'processing', amount_usd: 210 },
  };

  /** Next calls to `path` return these statuses (or time out) before normal behaviour resumes. */
  failNext(path: string, ...outcomes: Scripted[]): void {
    this.scripted.set(path, [...(this.scripted.get(path) ?? []), ...outcomes]);
  }

  executed(path?: string): WorldCall[] {
    return this.calls.filter((c) => !c.replayed && c.status >= 200 && c.status < 300 && (!path || c.path === path));
  }

  replays(path?: string): WorldCall[] {
    return this.calls.filter((c) => c.replayed && (!path || c.path === path));
  }

  async request(req: WorldRequest): Promise<WorldResponse> {
    const path = new URL(req.url).pathname;
    const record = (status: number, replayed = false) =>
      this.calls.push({ method: req.method, path, body: req.body, idempotencyKey: req.idempotencyKey, replayed, status });

    if (req.idempotencyKey && this.cache.has(req.idempotencyKey)) {
      const cached = this.cache.get(req.idempotencyKey)!;
      record(cached.status, true);
      return cached;
    }

    const outcome = this.scripted.get(path)?.shift();
    if (outcome === 'timeout') {
      record(0);
      throw new TransientError('timeout', `${req.method} ${path} timed out after ${req.timeoutMs} ms`);
    }
    if (typeof outcome === 'number') {
      record(outcome);
      return { status: outcome, body: { error: { message: 'injected failure' } } };
    }

    const res = this.route(req.method, path, req.body);
    record(res.status);
    if (req.idempotencyKey && res.status >= 200 && res.status < 300) this.cache.set(req.idempotencyKey, res);
    return res;
  }

  private route(method: string, path: string, body: unknown): WorldResponse {
    const id = () => `${++this.seq}`.padStart(6, '0');
    if (method === 'POST' && path === '/email/send') return { status: 200, body: { delivered: true, notification_id: `eml_${id()}` } };
    if (method === 'POST' && path === '/chat/message') return { status: 200, body: { delivered: true, notification_id: `msg_${id()}` } };
    if (method === 'POST' && path === '/shipments') {
      return { status: 201, body: { shipment_id: `shp_${id()}`, order_id: (body as { order_id?: string })?.order_id, status: 'created' } };
    }
    const order = /^\/orders\/([^/]+)(\/refund|\/replacement)?$/.exec(path);
    if (order) {
      const record = this.orders[order[1]!];
      if (!record) return { status: 404, body: { error: { message: `Unknown order ${order[1]}` } } };
      if (method === 'GET' && !order[2]) return { status: 200, body: { order_id: order[1], ...record } };
      if (method === 'POST' && order[2] === '/refund') {
        if (record.status === 'refunded') return { status: 409, body: { error: { message: 'already refunded' } } };
        const amount = (body as { amount_usd?: number })?.amount_usd ?? record.amount_usd;
        if (amount > record.amount_usd) return { status: 400, body: { error: { message: 'exceeds order total' } } };
        record.status = 'refunded';
        return { status: 200, body: { status: 'refunded', reference_id: `ref_${id()}`, amount_usd: amount } };
      }
      if (method === 'POST' && order[2] === '/replacement') return { status: 201, body: { status: 'replacement_created', reference_id: `rpl_${id()}` } };
    }
    return { status: 404, body: { error: { message: `Unknown path ${path}` } } };
  }
}
