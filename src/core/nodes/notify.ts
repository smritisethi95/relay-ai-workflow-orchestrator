import { PermanentError } from '../domain/errors.js';
import { errorForStatus } from '../engine/retry.js';
import type { NodeHandler } from './types.js';

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** Sends email/chat through the mock world. Targets come only from the workflow definition. */
export const notifyHandler: NodeHandler = {
  async execute({ node, params, idempotencyKey, world, settings }) {
    const channel = params.channel;
    let path: string;
    let body: Record<string, string>;
    if (channel === 'email') {
      path = '/email/send';
      body = { to: text(params.to), message: text(params.message) };
      if (params.subject !== undefined) body.subject = text(params.subject);
    } else if (channel === 'chat') {
      path = '/chat/message';
      body = { channel: text(params.to), message: text(params.message) };
    } else {
      throw new PermanentError('invalid_param', `Notify '${node.id}' has unsupported channel '${String(channel)}'`);
    }

    const res = await world.request({
      method: 'POST',
      url: `${settings.mockWorldUrl}${path}`,
      body,
      idempotencyKey,
      timeoutMs: settings.httpTimeoutMs,
    });
    if (res.status < 200 || res.status >= 300) throw errorForStatus(res.status, res.body, `notify ${channel}`);

    const out = (res.body ?? {}) as { delivered?: unknown; notification_id?: unknown };
    return { kind: 'completed', output: { delivered: out.delivered === true, notification_id: out.notification_id ?? null } };
  },
};
