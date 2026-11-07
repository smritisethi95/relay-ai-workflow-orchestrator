import { describe, expect, it } from 'vitest';
import { validateDefinition } from '../../src/core/catalog/validator.js';
import { loadCatalog, loadSeedWorkflows } from '../../src/infra/data/pack-data.js';

const catalog = loadCatalog();
const seeds = loadSeedWorkflows();

function minimal(nodes: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf_test',
    name: 'Test',
    trigger: { type: 'manual' },
    entry: 'n1',
    limits: { max_steps: 5 },
    nodes,
    ...overrides,
  };
}

const codes = (r: ReturnType<typeof validateDefinition>) => r.errors.map((e) => e.code);

describe('validateDefinition', () => {
  it.each(seeds.map((s) => [s.id, s]))('accepts seed %s', (_id, seed) => {
    const result = validateDefinition(seed, catalog);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts loops (wf_runaway polls back to check_order)', () => {
    const runaway = seeds.find((s) => s.id === 'wf_runaway')!;
    expect(runaway.nodes.find((n) => n.id === 'hold')?.next).toBe('check_order');
    expect(validateDefinition(runaway, catalog).ok).toBe(true);
  });

  // The three smoke-test rejection cases, each with a distinct code.
  it('rejects an unknown node type', () => {
    const r = validateDefinition(minimal([{ id: 'n1', type: 'teleport', params: {}, next: null }]), catalog);
    expect(codes(r)).toEqual(['invalid_node_type']);
    expect(r.errors[0]!.message).toBe("Node 'n1' has unknown type 'teleport'");
  });

  it('rejects a missing required param', () => {
    const r = validateDefinition(minimal([{ id: 'n1', type: 'notify', params: { channel: 'chat' }, next: null }]), catalog);
    expect(codes(r)).toEqual(['missing_param', 'missing_param']);
    expect(r.errors.map((e) => e.message)).toEqual([
      "Node 'n1' (notify) is missing required param 'to'",
      "Node 'n1' (notify) is missing required param 'message'",
    ]);
  });

  it('rejects a reference to a nonexistent node', () => {
    const r = validateDefinition(minimal([{ id: 'n1', type: 'delay', params: { seconds: 1 }, next: 'ghost' }]), catalog);
    expect(codes(r)).toEqual(['dangling_reference']);
    expect(r.errors[0]!.message).toContain("'ghost' does not exist");
  });

  it('rejects an entry that is not a node', () => {
    const r = validateDefinition(minimal([{ id: 'n1', type: 'delay', params: { seconds: 1 }, next: null }], { entry: 'start' }), catalog);
    expect(codes(r)).toEqual(['invalid_entry']);
  });

  it('rejects dangling on_true / on_false', () => {
    const r = validateDefinition(
      minimal([{ id: 'n1', type: 'condition', params: { left: 'a', op: 'equals', right: 'b' }, on_true: 'x', on_false: 'y' }]),
      catalog,
    );
    expect(codes(r)).toEqual(['dangling_reference', 'dangling_reference']);
  });

  it('rejects duplicate node ids', () => {
    const node = { id: 'n1', type: 'delay', params: { seconds: 1 }, next: null };
    expect(codes(validateDefinition(minimal([node, node]), catalog))).toEqual(['duplicate_node_id']);
  });

  it('rejects enum violations', () => {
    const r = validateDefinition(
      minimal([{ id: 'n1', type: 'condition', params: { left: 'a', op: 'roughly', right: 'b' }, on_true: 'n1', on_false: 'n1' }]),
      catalog,
    );
    expect(codes(r)).toEqual(['invalid_param']);
  });

  it('rejects a condition node missing a branch', () => {
    const r = validateDefinition(
      minimal([{ id: 'n1', type: 'condition', params: { left: 'a', op: 'equals', right: 'b' }, on_true: 'n1' }]),
      catalog,
    );
    expect(codes(r)).toEqual(['invalid_edges']);
  });

  it('rejects an invalid ai output_schema', () => {
    const r = validateDefinition(
      minimal([{ id: 'n1', type: 'ai', params: { prompt: 'hi', output_schema: { type: 'banana' } }, next: null }]),
      catalog,
    );
    expect(codes(r)).toEqual(['invalid_output_schema']);
  });

  it('rejects a webhook trigger without a secret', () => {
    const r = validateDefinition(minimal([{ id: 'n1', type: 'delay', params: { seconds: 1 }, next: null }], { trigger: { type: 'webhook' } }), catalog);
    expect(codes(r)).toEqual(['invalid_trigger']);
  });

  it('rejects missing or out-of-range max_steps', () => {
    const node = { id: 'n1', type: 'delay', params: { seconds: 1 }, next: null };
    expect(codes(validateDefinition(minimal([node], { limits: {} }), catalog))).toEqual(['invalid_limits']);
    expect(codes(validateDefinition(minimal([node], { limits: { max_steps: 0 } }), catalog))).toEqual(['invalid_limits']);
  });

  it('rejects keys MongoDB could treat as operators', () => {
    const r = validateDefinition(minimal([{ id: 'n1', type: 'delay', params: { seconds: 1, $where: 'x' }, next: null }]), catalog);
    expect(codes(r)).toContain('invalid_key');
  });

  it('collects every error instead of stopping at the first', () => {
    const r = validateDefinition(
      minimal([
        { id: 'n1', type: 'teleport', params: {}, next: 'n2' },
        { id: 'n2', type: 'notify', params: { channel: 'chat' }, next: 'ghost' },
      ]),
      catalog,
    );
    expect(new Set(codes(r))).toEqual(new Set(['invalid_node_type', 'missing_param', 'dangling_reference']));
  });

  it('warns when an order_action can be reached without an approval', () => {
    const r = validateDefinition(
      minimal([{ id: 'n1', type: 'order_action', params: { action: 'refund', order_id: 'ord_1' }, next: null }]),
      catalog,
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('approval_not_guaranteed');
  });

  it('does not warn when every path to order_action passes an approval', () => {
    const triage = seeds.find((s) => s.id === 'wf_support_triage')!;
    expect(validateDefinition(triage, catalog).warnings.map((w) => w.code)).not.toContain('approval_not_guaranteed');
  });

  it('rejects non-object input', () => {
    expect(codes(validateDefinition(null, catalog))).toEqual(['invalid_definition']);
    expect(codes(validateDefinition([], catalog))).toEqual(['invalid_definition']);
  });
});
