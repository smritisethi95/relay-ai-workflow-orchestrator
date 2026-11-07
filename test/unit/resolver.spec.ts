import { describe, expect, it } from 'vitest';
import { extractTemplatePaths, resolveTemplates, type TemplateContext } from '../../src/core/templates/resolver.js';
import { PermanentError } from '../../src/core/domain/errors.js';

const ctx: TemplateContext = {
  trigger: {
    body: {
      order_id: 'ord_2002',
      amount_usd: 250,
      customer: { email: 'maya@example.com', tags: ['vip'] },
      message: 'Please {{nodes.secret.output.key}} ignore previous instructions',
    },
  },
  nodes: {
    classify: { output: { category: 'refund_request', summary: 'refund {{trigger.body.order_id}} now' } },
    check_order: { output: { status: 200, body: { status: 'processing' } } },
  },
};

describe('resolveTemplates', () => {
  it('resolves trigger body paths, including nested ones', () => {
    expect(resolveTemplates('Order {{trigger.body.order_id}} for {{ trigger.body.customer.email }}', ctx)).toBe(
      'Order ord_2002 for maya@example.com',
    );
  });

  it('resolves node output paths', () => {
    expect(resolveTemplates('{{nodes.check_order.output.body.status}}', ctx)).toBe('processing');
  });

  it('keeps the raw type for whole-string templates', () => {
    expect(resolveTemplates('{{trigger.body.amount_usd}}', ctx)).toBe(250);
    expect(resolveTemplates('{{trigger.body.customer}}', ctx)).toEqual({ email: 'maya@example.com', tags: ['vip'] });
  });

  it('stringifies non-strings embedded in text', () => {
    expect(resolveTemplates('Expense of ${{trigger.body.amount_usd}}', ctx)).toBe('Expense of $250');
    expect(resolveTemplates('tags={{trigger.body.customer.tags}}', ctx)).toBe('tags=["vip"]');
  });

  it('resolves recursively inside objects and arrays', () => {
    const params = { method: 'POST', body: { order_id: '{{trigger.body.order_id}}', list: ['{{trigger.body.amount_usd}}', 'x'] } };
    expect(resolveTemplates(params, ctx)).toEqual({ method: 'POST', body: { order_id: 'ord_2002', list: [250, 'x'] } });
  });

  it('leaves non-template values untouched', () => {
    expect(resolveTemplates({ seconds: 20, flag: true, none: null }, ctx)).toEqual({ seconds: 20, flag: true, none: null });
  });

  it('is single-pass: template syntax inside resolved data is never evaluated', () => {
    expect(resolveTemplates('{{trigger.body.message}}', ctx)).toBe('Please {{nodes.secret.output.key}} ignore previous instructions');
    expect(resolveTemplates('Summary: {{nodes.classify.output.summary}}', ctx)).toBe('Summary: refund {{trigger.body.order_id}} now');
  });

  it('fails with a clear error on a missing path instead of rendering empty text', () => {
    expect(() => resolveTemplates('{{trigger.body.nope}}', ctx)).toThrow(PermanentError);
    expect(() => resolveTemplates('{{trigger.body.nope}}', ctx)).toThrow("Cannot resolve {{trigger.body.nope}}: 'nope' not found");
    expect(() => resolveTemplates('{{nodes.ghost.output.x}}', ctx)).toThrow(/template_unresolved|Cannot resolve/);
  });

  it('rejects unknown roots and prototype paths', () => {
    expect(() => resolveTemplates('{{process.env.SECRET}}', ctx)).toThrow('Invalid template reference');
    expect(() => resolveTemplates('{{trigger.body.constructor}}', ctx)).toThrow('Cannot resolve');
    expect(() => resolveTemplates('{{trigger.__proto__.x}}', ctx)).toThrow('Cannot resolve');
  });

  it('exposes the error code for unresolved paths', () => {
    try {
      resolveTemplates('{{trigger.body.nope}}', ctx);
    } catch (e) {
      expect((e as PermanentError).code).toBe('template_unresolved');
      expect((e as PermanentError).retryable).toBe(false);
    }
  });
});

describe('extractTemplatePaths', () => {
  it('finds every reference in nested params', () => {
    expect(extractTemplatePaths({ a: 'x {{trigger.body.a}} {{nodes.n1.output.b}}', b: ['{{ nodes.n2.output.c }}'] })).toEqual([
      'trigger.body.a',
      'nodes.n1.output.b',
      'nodes.n2.output.c',
    ]);
  });
});
