import { PermanentError } from '../domain/errors.js';
import type { NodeHandler } from './types.js';

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function asNumber(text: string, side: string, nodeId: string): number {
  const n = text.trim() === '' ? NaN : Number(text);
  if (!Number.isFinite(n)) {
    throw new PermanentError('non_numeric_comparison', `Condition '${nodeId}': ${side} value '${text}' is not a number`);
  }
  return n;
}

export const conditionHandler: NodeHandler = {
  async execute({ node, params }) {
    const left = asText(params.left);
    const right = asText(params.right);
    const op = params.op;

    let result: boolean;
    switch (op) {
      case 'equals':
        result = left === right;
        break;
      case 'not_equals':
        result = left !== right;
        break;
      case 'contains':
        result = left.includes(right);
        break;
      case 'greater_than':
        result = asNumber(left, 'left', node.id) > asNumber(right, 'right', node.id);
        break;
      case 'less_than':
        result = asNumber(left, 'left', node.id) < asNumber(right, 'right', node.id);
        break;
      default:
        throw new PermanentError('invalid_param', `Condition '${node.id}' has unsupported op '${String(op)}'`);
    }
    return { kind: 'completed', output: { result }, next: result ? node.on_true! : node.on_false! };
  },
};
