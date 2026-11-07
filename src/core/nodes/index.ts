import type { NodeType } from '../domain/types.js';
import { aiHandler } from './ai.js';
import { approvalHandler } from './approval.js';
import { conditionHandler } from './condition.js';
import { delayHandler } from './delay.js';
import { httpRequestHandler } from './http-request.js';
import { notifyHandler } from './notify.js';
import { orderActionHandler } from './order-action.js';
import type { NodeHandler } from './types.js';

export type HandlerRegistry = Partial<Record<NodeType, NodeHandler>>;

export function defaultHandlers(extra: HandlerRegistry = {}): HandlerRegistry {
  return {
    condition: conditionHandler,
    delay: delayHandler,
    notify: notifyHandler,
    http_request: httpRequestHandler,
    ai: aiHandler,
    approval: approvalHandler,
    order_action: orderActionHandler,
    ...extra,
  };
}
