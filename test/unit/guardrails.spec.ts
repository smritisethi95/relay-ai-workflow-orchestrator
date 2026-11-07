import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../../src/core/guardrails/redact.js';
import { findUnsafeKey } from '../../src/core/guardrails/safe-keys.js';
import { toErrorResponse } from '../../src/api/error-response.js';
import { DomainError } from '../../src/core/domain/errors.js';

describe('redactSecrets', () => {
  it('masks webhook secrets, API keys and auth headers at any depth', () => {
    const input = {
      trigger: { type: 'webhook', secret: 'whsec_expense_774' },
      limits: { max_steps: 20, max_ai_tokens: 10000 },
      nodes: [{ params: { headers: { Authorization: 'Bearer abc', 'X-Relay-Secret': 's', api_key: 'k' } } }],
    };
    const out = redactSecrets(input);
    expect(out.trigger.secret).toBe(REDACTED);
    expect(out.limits.max_ai_tokens).toBe(10000);
    expect(out.nodes[0]!.params.headers).toEqual({ Authorization: REDACTED, 'X-Relay-Secret': REDACTED, api_key: REDACTED });
    expect(input.trigger.secret).toBe('whsec_expense_774');
  });

  it('keeps dates intact', () => {
    const d = new Date();
    expect(redactSecrets({ at: d }).at).toBe(d);
  });
});

describe('findUnsafeKey', () => {
  it('finds operator and dotted keys anywhere', () => {
    expect(findUnsafeKey({ a: { b: [{ $gt: 1 }] } })).toBe('a.b[0].$gt');
    expect(findUnsafeKey({ 'a.b': 1 })).toBe('a.b');
    expect(findUnsafeKey({ a: 'x', b: [1, { c: 2 }] })).toBeNull();
  });
});

describe('toErrorResponse', () => {
  it('maps domain errors to the contract error shape', () => {
    expect(toErrorResponse(new DomainError('workflow_exists', 'exists', 409))).toEqual({
      status: 409,
      body: { error: { code: 'workflow_exists', message: 'exists' } },
    });
  });

  it('never leaks internal error messages', () => {
    expect(toErrorResponse(new Error('connection string mongodb+srv://user:pw@x'))).toEqual({
      status: 500,
      body: { error: { code: 'internal_error', message: 'Internal server error' } },
    });
  });
});
