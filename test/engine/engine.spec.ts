import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/core/domain/errors.js';
import { createHarness, LEASE_MS } from '../fakes/harness.js';

const manualWorkflow = (id: string, nodes: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  trigger: { type: 'manual' },
  entry: (nodes[0] as { id: string }).id,
  limits: { max_steps: 20 },
  nodes,
  ...extra,
});

describe('Engine — deterministic workflows', () => {
  it('runs wf_expense_approval $40 to succeeded via the auto_ok branch with a keyed email', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerWebhook('wf_expense_approval', 'whsec_expense_774', {
      employee_email: 'dev2@example.com',
      amount_usd: 40,
      description: 'Team lunch',
    });
    expect(run.status).toBe('queued');
    await h.drain();

    const stored = (await h.repo.getRun(run.id))!;
    expect(stored.status).toBe('succeeded');
    expect(stored.ended_by).toBe('completed');
    const steps = await h.repo.listSteps(run.id);
    expect(steps.map((s) => [s.node_id, s.status])).toEqual([
      ['is_large', 'succeeded'],
      ['auto_ok', 'succeeded'],
    ]);
    expect(steps[0]!.output).toEqual({ result: false });
    expect(steps[0]!.resolved_input).toEqual({ left: 40, op: 'greater_than', right: '100' });
    const emails = h.world.executed('/email/send');
    expect(emails).toHaveLength(1);
    expect(emails[0]!.idempotencyKey).toBe(`${run.id}:auto_ok:2`);
    expect(emails[0]!.body).toMatchObject({ to: 'dev2@example.com', subject: 'Expense auto-approved' });
    expect(h.repo.peekJob(run.id)).toBeUndefined();
  });

  it('pauses wf_expense_approval $250 at the approval gate with a pending approval and no job', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_expense_approval', { employee_email: 'dev1@example.com', amount_usd: 250, description: 'Conference ticket' });
    await h.drain();

    expect((await h.repo.getRun(run.id))!.status).toBe('waiting_approval');
    const approvals = await h.repo.listApprovals({ run_id: run.id });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: 'pending', node_id: 'finance_gate', message: 'Expense of $250 from dev1@example.com: Conference ticket' });
    expect(h.world.calls).toHaveLength(0);
    expect(h.repo.peekJob(run.id)).toBeUndefined();
  });

  it('runs wf_slow_fulfillment through a durable delay, each side effect once', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_slow_fulfillment', { order_id: 'ord_2003', customer_email: 'lena@example.com' });
    await h.drain();

    const steps = await h.repo.listSteps(run.id);
    expect(steps.map((s) => s.node_id)).toEqual(['confirm', 'pack_delay', 'create_shipment', 'shipped_notice']);
    expect((await h.repo.getRun(run.id))!.status).toBe('succeeded');
    expect(h.world.executed('/email/send')).toHaveLength(2);
    expect(h.world.executed('/shipments')).toHaveLength(1);
    const shipmentId = (steps[2]!.output as { body: { shipment_id: string } }).body.shipment_id;
    expect((h.world.executed('/email/send')[1]!.body as { message: string }).message).toContain(shipmentId);
  });
});

describe('Engine — step cap', () => {
  it('stops wf_runaway at max_steps=12 with a reason naming the cap', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_runaway', {});
    await h.drain();

    const stored = (await h.repo.getRun(run.id))!;
    expect(stored.status).toBe('failed');
    expect(stored.ended_by).toBe('cap_exceeded');
    expect(stored.steps_executed).toBe(12);
    expect(stored.error).toMatchObject({ code: 'max_steps_exceeded' });
    expect(stored.error!.message).toContain('max_steps=12');
    expect(await h.repo.listSteps(run.id)).toHaveLength(12);
    expect(h.world.calls.filter((c) => c.path === '/orders/ord_2001')).toHaveLength(4);
  });
});

describe('Engine — exactly-once side effects', () => {
  it('re-executes an in-flight step with the SAME key after a crash between the call and its persist', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_slow_fulfillment', { order_id: 'ord_2003', customer_email: 'lena@example.com' });

    const original = h.repo.updateStep.bind(h.repo);
    let crashed = false;
    h.repo.updateStep = async (runId, sequence, patch, from) => {
      const step = (await h.repo.listSteps(runId)).find((s) => s.sequence === sequence);
      if (!crashed && step?.node_id === 'create_shipment' && patch.status === 'succeeded') {
        crashed = true;
        throw new Error('simulated worker death after the side effect, before persisting it');
      }
      return original(runId, sequence, patch, from);
    };

    await expect(h.drain()).rejects.toThrow('simulated worker death');
    expect(h.world.executed('/shipments')).toHaveLength(1);
    const inFlight = (await h.repo.listSteps(run.id)).find((s) => s.node_id === 'create_shipment')!;
    expect(inFlight.status).toBe('running');

    // A new worker reclaims the run once the dead worker's lease expires.
    await h.drain('w2');

    expect((await h.repo.getRun(run.id))!.status).toBe('succeeded');
    expect(h.world.executed('/shipments')).toHaveLength(1);
    expect(h.world.replays('/shipments')).toHaveLength(1);
    const keys = h.world.calls.filter((c) => c.path === '/shipments').map((c) => c.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`${run.id}:create_shipment:3`]));
    expect(h.world.executed('/email/send')).toHaveLength(2);
  });

  it('retries transient failures with the same key and records every attempt', async () => {
    const h = await createHarness();
    h.world.failNext('/email/send', 503, 'timeout');
    const run = await h.triggers.triggerManual('wf_expense_approval', { employee_email: 'a@example.com', amount_usd: 10, description: 'x' });
    await h.drain();

    const step = (await h.repo.listSteps(run.id)).find((s) => s.node_id === 'auto_ok')!;
    expect(step.status).toBe('succeeded');
    expect(step.attempt).toBe(3);
    expect(step.attempts_log.map((a) => a.error ?? 'ok')).toEqual([
      expect.stringContaining('HTTP 503'),
      expect.stringContaining('timed out'),
      'ok',
    ]);
    expect(new Set(h.world.calls.map((c) => c.idempotencyKey))).toEqual(new Set([`${run.id}:auto_ok:2`]));
    expect(h.world.executed('/email/send')).toHaveLength(1);
  });

  it('fails fast on a 4xx without retrying', async () => {
    const h = await createHarness();
    h.world.failNext('/email/send', 400);
    const run = await h.triggers.triggerManual('wf_expense_approval', { employee_email: 'a@example.com', amount_usd: 10, description: 'x' });
    await h.drain();

    const stored = (await h.repo.getRun(run.id))!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatchObject({ code: 'http_error', node_id: 'auto_ok' });
    expect(h.world.calls).toHaveLength(1);
  });

  it('gives up after MAX_ATTEMPTS transient failures', async () => {
    const h = await createHarness();
    h.world.failNext('/email/send', 503, 503, 503, 503);
    const run = await h.triggers.triggerManual('wf_expense_approval', { employee_email: 'a@example.com', amount_usd: 10, description: 'x' });
    await h.drain();

    const stored = (await h.repo.getRun(run.id))!;
    expect(stored.status).toBe('failed');
    expect(stored.error!.message).toContain('gave up after 4 attempts');
    expect(h.world.calls).toHaveLength(4);
  });

  it('gives each loop iteration its own key (sequence), so legitimate repeats are not suppressed', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_runaway', {});
    await h.drain();
    const keys = h.world.calls.map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('Engine — guardrails', () => {
  it('refuses an order_action when no approval exists (gate bypass by construction)', async () => {
    const h = await createHarness();
    await h.publish(
      manualWorkflow('wf_no_gate', [{ id: 'refund', type: 'order_action', params: { action: 'refund', order_id: 'ord_2002' }, next: null }]),
    );
    const run = await h.triggers.triggerManual('wf_no_gate', {});
    await h.drain();

    const stored = (await h.repo.getRun(run.id))!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatchObject({ code: 'approval_required', node_id: 'refund' });
    expect(h.world.calls).toHaveLength(0);
    expect(h.world.orders.ord_2002!.status).toBe('delivered');
  });

  it('refuses an order_action whose approval sits on the other branch', async () => {
    const h = await createHarness();
    await h.publish(
      manualWorkflow('wf_wrong_branch', [
        { id: 'route', type: 'condition', params: { left: '{{trigger.body.kind}}', op: 'equals', right: 'refund' }, on_true: 'refund', on_false: 'gate' },
        { id: 'gate', type: 'approval', params: { message: 'approve?' }, next: 'refund' },
        { id: 'refund', type: 'order_action', params: { action: 'refund', order_id: 'ord_2002' }, next: null },
      ]),
    );
    const run = await h.triggers.triggerManual('wf_wrong_branch', { kind: 'refund' });
    await h.drain();

    expect((await h.repo.getRun(run.id))!.error).toMatchObject({ code: 'approval_required' });
    expect(h.world.calls).toHaveLength(0);
  });

  it('fails a step with a clear error when a template cannot be resolved', async () => {
    const h = await createHarness();
    await h.publish(
      manualWorkflow('wf_tpl', [{ id: 'say', type: 'notify', params: { channel: 'chat', to: '#x', message: 'hi {{trigger.body.missing}}' }, next: null }]),
    );
    const run = await h.triggers.triggerManual('wf_tpl', {});
    await h.drain();

    const stored = (await h.repo.getRun(run.id))!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatchObject({ code: 'template_unresolved', node_id: 'say' });
    expect((await h.repo.listSteps(run.id))[0]).toMatchObject({ node_id: 'say', status: 'failed' });
    expect(h.world.calls).toHaveLength(0);
  });

  it('blocks http_request to hosts outside the allow-list (SSRF)', async () => {
    const h = await createHarness();
    await h.publish(
      manualWorkflow('wf_ssrf', [{ id: 'grab', type: 'http_request', params: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data' }, next: null }]),
    );
    const run = await h.triggers.triggerManual('wf_ssrf', {});
    await h.drain();

    expect((await h.repo.getRun(run.id))!.error).toMatchObject({ code: 'url_not_allowed' });
    expect(h.world.calls).toHaveLength(0);
  });

  it('executes the snapshot it started with even after the workflow is edited and republished', async () => {
    const h = await createHarness();
    const def = manualWorkflow('wf_snap', [
      { id: 'wait', type: 'delay', params: { seconds: 5 }, next: 'say' },
      { id: 'say', type: 'notify', params: { channel: 'chat', to: '#v1', message: 'version one' }, next: null },
    ]);
    await h.publish(def);
    const run = await h.triggers.triggerManual('wf_snap', {});

    const job = await h.repo.claim('w1', LEASE_MS, h.clock.now());
    await h.engine.advance(job!.runId, 'w1', job!.claimCount);

    const v2 = manualWorkflow('wf_snap', [
      { id: 'wait', type: 'delay', params: { seconds: 5 }, next: 'say' },
      { id: 'say', type: 'notify', params: { channel: 'chat', to: '#v2', message: 'version two' }, next: null },
    ]);
    await h.workflows.updateDraft('wf_snap', v2);
    await h.workflows.publish('wf_snap');

    await h.drain();
    expect(h.world.executed('/chat/message').map((c) => c.body)).toEqual([{ channel: '#v1', message: 'version one' }]);
    expect((await h.repo.getRun(run.id))!.workflow_version).toBe(1);
  });
});

describe('Engine — leases and fencing', () => {
  it('a worker that lost its lease cannot write progress', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_expense_approval', { employee_email: 'a@example.com', amount_usd: 10, description: 'x' });
    await h.repo.claim('w1', LEASE_MS, h.clock.now());
    h.clock.advance(LEASE_MS + 1);
    await h.repo.claim('w2', LEASE_MS, h.clock.now());

    expect(await h.engine.advance(run.id, 'w1')).toBe('lost_lease');
    expect(await h.repo.listSteps(run.id)).toHaveLength(0);
  });

  it('fails a run that keeps crashing its worker (poison job)', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_expense_approval', { employee_email: 'a@example.com', amount_usd: 10, description: 'x' });
    await h.repo.claim('w1', LEASE_MS, h.clock.now());
    expect(await h.engine.advance(run.id, 'w1', 11)).toBe('finished');
    expect((await h.repo.getRun(run.id))!.error).toMatchObject({ code: 'poison_job' });
  });
});

describe('TriggerService', () => {
  it('enforces the webhook secret, trigger type and publish state', async () => {
    const h = await createHarness();
    const body = { employee_email: 'a@example.com', amount_usd: 1, description: 'x' };
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: DomainError) => `${e.httpStatus} ${e.code}`);

    expect(await code(h.triggers.triggerWebhook('wf_expense_approval', 'wrong', body))).toBe('401 invalid_webhook_secret');
    expect(await code(h.triggers.triggerWebhook('wf_expense_approval', undefined, body))).toBe('401 invalid_webhook_secret');
    expect(await code(h.triggers.triggerWebhook('wf_slow_fulfillment', 'x', body))).toBe('409 trigger_type_mismatch');
    expect(await code(h.triggers.triggerWebhook('wf_ghost', 'x', body))).toBe('404 not_found');
    expect(await code(h.triggers.triggerManual('wf_expense_approval', [1, 2]))).toBe('400 invalid_input');
    expect(await code(h.triggers.triggerManual('wf_expense_approval', { $gt: 1 }))).toBe('400 invalid_key');

    await h.workflows.create(manualWorkflow('wf_draft_only', [{ id: 'd', type: 'delay', params: { seconds: 0 }, next: null }]));
    expect(await code(h.triggers.triggerManual('wf_draft_only', {}))).toBe('409 workflow_not_published');
  });

  it('creates one run per webhook delivery (at-least-once), each with its own snapshot and job', async () => {
    const h = await createHarness();
    const body = { employee_email: 'a@example.com', amount_usd: 1, description: 'x' };
    const a = await h.triggers.triggerWebhook('wf_expense_approval', 'whsec_expense_774', body);
    const b = await h.triggers.triggerWebhook('wf_expense_approval', 'whsec_expense_774', body);
    expect(a.id).not.toBe(b.id);
    expect(h.repo.peekJob(a.id)).toBeDefined();
    expect(h.repo.peekJob(b.id)).toBeDefined();
    await h.drain();
    expect(h.world.executed('/email/send')).toHaveLength(2);
  });
});
