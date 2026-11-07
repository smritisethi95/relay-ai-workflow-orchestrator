import { PermanentError } from '../domain/errors.js';
import { errorForStatus } from '../engine/retry.js';
import type { NodeHandler } from './types.js';

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Sensitive commerce action. The engine gates it on an approved approval; this re-check is defence in depth. */
export const orderActionHandler: NodeHandler = {
  async execute({ node, params, idempotencyKey, approvalGranted, world, settings }) {
    if (!approvalGranted) {
      throw new PermanentError('approval_required', `order_action '${node.id}' refused: no approved approval for this run`);
    }
    const orderId = String(params.order_id ?? '');
    if (!ORDER_ID.test(orderId)) {
      throw new PermanentError('invalid_param', `order_action '${node.id}' has an invalid order_id`);
    }

    let path: string;
    let body: Record<string, unknown> = {};
    if (params.action === 'refund') {
      path = `/orders/${encodeURIComponent(orderId)}/refund`;
      if (params.amount_usd !== undefined) body = { amount_usd: params.amount_usd };
    } else if (params.action === 'replacement') {
      path = `/orders/${encodeURIComponent(orderId)}/replacement`;
    } else {
      throw new PermanentError('invalid_param', `order_action '${node.id}' has unsupported action '${String(params.action)}'`);
    }

    const res = await world.request({
      method: 'POST',
      url: `${settings.mockWorldUrl}${path}`,
      body,
      idempotencyKey,
      timeoutMs: settings.httpTimeoutMs,
    });
    if (res.status < 200 || res.status >= 300) throw errorForStatus(res.status, res.body, `order ${params.action}`);

    const out = (res.body ?? {}) as { status?: unknown; reference_id?: unknown };
    return { kind: 'completed', output: { status: out.status ?? null, reference_id: out.reference_id ?? null } };
  },
};
