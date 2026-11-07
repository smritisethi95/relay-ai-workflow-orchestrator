import { describe, expect, it } from 'vitest';
import type { DomainError } from '../../src/core/domain/errors.js';
import { createHarness, LEASE_MS } from '../fakes/harness.js';

const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: DomainError) => `${e.httpStatus} ${e.code}`);

const refundFlow = {
  id: 'wf_refund_gate',
  name: 'Refund behind a gate',
  trigger: { type: 'manual' },
  entry: 'gate',
  limits: { max_steps: 10 },
  nodes: [
    { id: 'gate', type: 'approval', params: { message: 'Refund {{trigger.body.order_id}}?' }, next: 'refund' },
    { id: 'refund', type: 'order_action', params: { action: 'refund', order_id: '{{trigger.body.order_id}}' }, next: 'tell' },
    {
      id: 'tell',
      type: 'notify',
      params: { channel: 'email', to: 'c@example.com', subject: 'Refund', message: 'Ref {{nodes.refund.output.reference_id}}' },
      next: null,
    },
  ],
};

async function pausedExpense() {
  const h = await createHarness();
  const run = await h.triggers.triggerWebhook('wf_expense_approval', 'whsec_expense_774', {
    employee_email: 'dev1@example.com',
    amount_usd: 250,
    description: 'Conference ticket',
  });
  await h.drain();
  const [approval] = await h.approvals.list('pending');
  return { h, run, approval: approval! };
}

describe('Approvals', () => {
  it('lists the pending approval with run and workflow ids', async () => {
    const { run, approval } = await pausedExpense();
    expect(approval).toMatchObject({ run_id: run.id, workflow_id: 'wf_expense_approval', node_id: 'finance_gate', status: 'pending' });
  });

  it('approve resumes the run to succeeded and records who decided and when', async () => {
    const { h, run, approval } = await pausedExpense();
    const decided = await h.approvals.approve(approval.id, 'demo-user', 'looks fine');
    expect(decided).toMatchObject({ status: 'approved', decided_by: 'demo-user', comment: 'looks fine' });
    expect(decided.decided_at).toBeInstanceOf(Date);
    expect((await h.repo.getRun(run.id))!.status).toBe('running');

    await h.drain();
    const stored = (await h.repo.getRun(run.id))!;
    expect(stored.status).toBe('succeeded');
    const steps = await h.repo.listSteps(run.id);
    expect(steps.map((s) => [s.node_id, s.status])).toEqual([
      ['is_large', 'succeeded'],
      ['finance_gate', 'succeeded'],
      ['approved_notice', 'succeeded'],
    ]);
    expect(steps[1]!.output).toEqual({ decision: 'approved', decided_by: 'demo-user' });
    expect(h.world.executed('/email/send')).toHaveLength(1);
    expect(await h.approvals.list('pending')).toHaveLength(0);
  });

  it('a second decision on the same approval is rejected with 409', async () => {
    const { h, approval } = await pausedExpense();
    await h.approvals.approve(approval.id, 'demo-user');
    expect(await outcome(h.approvals.approve(approval.id, 'demo-user'))).toBe('409 approval_already_decided');
    expect(await outcome(h.approvals.reject(approval.id, 'demo-user'))).toBe('409 approval_already_decided');
    expect(await outcome(h.approvals.approve('apr_missing', 'demo-user'))).toBe('404 not_found');
  });

  it('reject ends the run cancelled, records the decision, and nothing downstream runs', async () => {
    const { h, run, approval } = await pausedExpense();
    await h.approvals.reject(approval.id, 'demo-user', 'not in budget');
    await h.drain();

    const stored = (await h.repo.getRun(run.id))!;
    expect(stored.status).toBe('cancelled');
    expect(stored.ended_by).toBe('rejected');
    expect((await h.repo.getApproval(approval.id))).toMatchObject({ status: 'rejected', decided_by: 'demo-user', comment: 'not in budget' });
    expect((await h.repo.listSteps(run.id)).at(-1)).toMatchObject({ node_id: 'finance_gate', status: 'cancelled' });
    expect(h.world.calls).toHaveLength(0);
  });

  it('only executes the refund after approval, exactly once, with a keyed call', async () => {
    const h = await createHarness();
    await h.publish(refundFlow);
    const run = await h.triggers.triggerManual('wf_refund_gate', { order_id: 'ord_2002' });
    await h.drain();
    expect(h.world.calls).toHaveLength(0);
    expect(h.world.orders.ord_2002!.status).toBe('delivered');

    const [approval] = await h.approvals.list('pending');
    await h.approvals.approve(approval!.id, 'demo-user');
    await h.drain();

    expect((await h.repo.getRun(run.id))!.status).toBe('succeeded');
    const refunds = h.world.executed('/orders/ord_2002/refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.idempotencyKey).toBe(`${run.id}:refund:2`);
    expect(h.world.orders.ord_2002!.status).toBe('refunded');
    const email = h.world.executed('/email/send')[0]!.body as { message: string };
    expect(email.message).toMatch(/^Ref ref_/);
  });

  it('a resumed run finishes on the definition it started with even if the workflow is republished while paused', async () => {
    const { h, run, approval } = await pausedExpense();
    const current = await h.workflows.get('wf_expense_approval');
    const edited = structuredClone(current.published_definition!) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    edited.nodes.find((n) => n.id === 'approved_notice')!.params.subject = 'EDITED SUBJECT';
    await h.workflows.updateDraft('wf_expense_approval', edited);
    await h.workflows.publish('wf_expense_approval');

    await h.approvals.approve(approval.id, 'demo-user');
    await h.drain();
    expect((await h.repo.getRun(run.id))!.workflow_version).toBe(1);
    expect(h.world.executed('/email/send')[0]!.body).toMatchObject({ subject: 'Expense approved' });
  });
});

describe('Cancel', () => {
  it('cancels a queued run without executing anything', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_slow_fulfillment', { order_id: 'ord_2003', customer_email: 'l@example.com' });
    const cancelled = await h.runs.cancel(run.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', ended_by: 'cancelled' });
    await h.drain();
    expect(await h.repo.listSteps(run.id)).toHaveLength(0);
    expect(h.world.calls).toHaveLength(0);
  });

  it('cancels a run waiting for approval and closes the approval', async () => {
    const { h, run, approval } = await pausedExpense();
    await h.runs.cancel(run.id);
    expect((await h.repo.getRun(run.id))!.status).toBe('cancelled');
    expect((await h.repo.getApproval(approval.id))!.status).toBe('closed');
    expect(await h.approvals.list('pending')).toHaveLength(0);
    expect(await outcome(h.approvals.approve(approval.id, 'demo-user'))).toBe('409 approval_already_decided');
  });

  it('stops a running run between steps (here: during its delay) and skips the remaining side effects', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_slow_fulfillment', { order_id: 'ord_2003', customer_email: 'l@example.com' });
    const job = await h.repo.claim('w1', LEASE_MS, h.clock.now());
    await h.engine.advance(job!.runId, 'w1', job!.claimCount);
    expect(h.world.executed('/email/send')).toHaveLength(1);

    const requested = await h.runs.cancel(run.id);
    expect(requested).toMatchObject({ status: 'running', cancel_requested: true });
    await h.drain();

    const stored = (await h.repo.getRun(run.id))!;
    expect(stored).toMatchObject({ status: 'cancelled', ended_by: 'cancelled' });
    expect((await h.repo.listSteps(run.id)).map((s) => [s.node_id, s.status])).toEqual([
      ['confirm', 'succeeded'],
      ['pack_delay', 'cancelled'],
    ]);
    expect(h.world.executed('/shipments')).toHaveLength(0);
  });

  it('returns 409 for a terminal run and 404 for an unknown one', async () => {
    const h = await createHarness();
    const run = await h.triggers.triggerManual('wf_expense_approval', { employee_email: 'a@example.com', amount_usd: 1, description: 'x' });
    await h.drain();
    expect(await outcome(h.runs.cancel(run.id))).toBe('409 run_already_terminal');
    expect(await outcome(h.runs.cancel('run_missing'))).toBe('404 not_found');
  });
});
