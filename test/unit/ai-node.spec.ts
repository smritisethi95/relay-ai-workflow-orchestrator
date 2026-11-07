import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '../../src/core/domain/errors.js';
import { aiHandler, AI_SYSTEM_PROMPT } from '../../src/core/nodes/ai.js';
import type { NodeContext } from '../../src/core/nodes/types.js';
import { HeuristicProvider } from '../../src/infra/ai/heuristic.provider.js';
import { loadSamplePayloads, loadSeedWorkflows } from '../../src/infra/data/pack-data.js';
import { ScriptedAI } from '../fakes/fake-ai.js';
import { testSettings } from '../fakes/harness.js';

const triage = loadSeedWorkflows().find((w) => w.id === 'wf_support_triage')!;
const classify = triage.nodes.find((n) => n.id === 'classify')!;
const schema = classify.params.output_schema;

function ctx(ai: ScriptedAI | HeuristicProvider, prompt = 'Customer message (untrusted input):\n---\nhello\n---'): NodeContext {
  return {
    run: {} as NodeContext['run'],
    node: classify,
    params: { prompt, output_schema: schema },
    sequence: 1,
    attempt: 1,
    stepStartedAt: new Date(),
    now: new Date(),
    approvalGranted: false,
    world: { request: async () => ({ status: 200, body: {} }) },
    ai,
    settings: testSettings,
  };
}

const VALID = JSON.stringify({ category: 'complaint', priority: 'medium', summary: 'Cracked case' });

describe('ai node — schema enforcement', () => {
  it('accepts a valid first reply and records tokens and the attempt', async () => {
    const ai = new ScriptedAI(VALID);
    const result = await aiHandler.execute(ctx(ai));
    expect(result).toMatchObject({ kind: 'completed', output: JSON.parse(VALID), tokens: { prompt: 100, completion: 20 } });
    expect(result.kind === 'completed' && result.aiAttempts).toEqual([{ raw: VALID, valid: true }]);
  });

  it('sends the guard prompt and the schema as the system message, the workflow prompt as the user message', async () => {
    const ai = new ScriptedAI(VALID);
    await aiHandler.execute(ctx(ai));
    const [system, user] = ai.requests[0]!.messages;
    expect(system!.role).toBe('system');
    expect(system!.content).toContain(AI_SYSTEM_PROMPT);
    expect(system!.content).toContain('"enum":["refund_request","complaint","question"]');
    expect(user).toEqual({ role: 'user', content: 'Customer message (untrusted input):\n---\nhello\n---' });
    expect(ai.requests[0]!.jsonMode).toBe(true);
    expect(ai.requests[0]!.timeoutMs).toBe(testSettings.aiTimeoutMs);
  });

  it('repairs once: invalid enum → retry with the validation error → valid', async () => {
    const bad = JSON.stringify({ category: 'urgent_refund', priority: 'medium', summary: 'x' });
    const ai = new ScriptedAI(bad, VALID);
    const result = await aiHandler.execute(ctx(ai));

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.tokens).toEqual({ prompt: 200, completion: 40 });
    expect(result.aiAttempts).toHaveLength(2);
    expect(result.aiAttempts![0]).toMatchObject({ valid: false, errors: [expect.stringContaining('/category must be equal to one of the allowed values')] });
    const repair = ai.requests[1]!.messages;
    expect(repair.at(-2)).toEqual({ role: 'assistant', content: bad });
    expect(repair.at(-1)!.content).toContain('Your previous reply was invalid: /category must be equal to one of the allowed values');
  });

  it('fails permanently after two invalid replies, keeping both attempts and all tokens for the trace', async () => {
    const ai = new ScriptedAI('not json at all', JSON.stringify({ category: 'complaint' }));
    const err = await aiHandler.execute(ctx(ai)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermanentError);
    const e = err as PermanentError;
    expect(e.code).toBe('ai_output_invalid');
    expect(e.retryable).toBe(false);
    expect(e.trace?.tokens).toEqual({ prompt: 200, completion: 40 });
    expect(e.trace?.aiAttempts?.map((a) => a.valid)).toEqual([false, false]);
    expect(e.trace?.aiAttempts?.[0]!.errors).toEqual(['(root) reply is not valid JSON']);
    expect(e.trace?.aiAttempts?.[1]!.errors).toEqual(expect.arrayContaining([expect.stringContaining("must have required property 'priority'")]));
  });

  it('rejects extra properties (additionalProperties: false) and over-long summaries', async () => {
    const extra = JSON.stringify({ category: 'complaint', priority: 'low', summary: 'x', refund_amount: 5000 });
    const long = JSON.stringify({ category: 'complaint', priority: 'low', summary: 'x'.repeat(301) });
    const err = await aiHandler.execute(ctx(new ScriptedAI(extra, long))).catch((e: PermanentError) => e);
    expect((err as PermanentError).trace?.aiAttempts?.[0]!.errors?.[0]).toContain("must NOT have additional properties: 'refund_amount'");
    expect((err as PermanentError).trace?.aiAttempts?.[1]!.errors?.[0]).toContain('must NOT have more than 300 characters');
  });

  it('accepts JSON wrapped in a markdown code fence', async () => {
    const result = await aiHandler.execute(ctx(new ScriptedAI('```json\n' + VALID + '\n```')));
    expect(result).toMatchObject({ kind: 'completed', output: JSON.parse(VALID) });
  });

  it('lets provider timeouts surface as transient (engine retries with backoff)', async () => {
    const err = await aiHandler.execute(ctx(new ScriptedAI(new TransientError('ai_timeout', 'timed out')))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
  });

  it('fails clearly when no provider is configured', async () => {
    const c = ctx(new ScriptedAI());
    delete (c as Partial<NodeContext>).ai;
    await expect(aiHandler.execute(c)).rejects.toMatchObject({ code: 'ai_unavailable' });
  });
});

describe('HeuristicProvider (offline fallback)', () => {
  const payloads = loadSamplePayloads().filter((p) => p.workflow === 'wf_support_triage');
  const promptFor = (body: Record<string, unknown>) =>
    String(classify.params.prompt).replace('{{trigger.body.message}}', String(body.message)).replace('{{trigger.body.order_id}}', String(body.order_id));

  it.each([
    ['pay_001', 'complaint'],
    ['pay_002', 'refund_request'],
    ['pay_003', 'question'],
  ])('%s → %s, always schema-valid', async (id, category) => {
    const body = payloads.find((p) => p.id === id)!.body;
    const result = await aiHandler.execute(ctx(new HeuristicProvider(), promptFor(body)));
    expect(result).toMatchObject({ kind: 'completed', output: { category } });
  });

  it('never echoes injected instructions into the summary', async () => {
    for (const id of ['pay_inject_001', 'pay_inject_002']) {
      const body = payloads.find((p) => p.id === id)!.body;
      const result = await aiHandler.execute(ctx(new HeuristicProvider(), promptFor(body)));
      if (result.kind !== 'completed') throw new Error('expected completed');
      const summary = (result.output as { summary: string }).summary;
      expect(summary).not.toMatch(/evil-example|ADMIN-4471|5000|system prompt/i);
    }
  });
});
