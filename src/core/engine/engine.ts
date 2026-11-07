import { ulid } from 'ulid';
import type { Catalog } from '../catalog/catalog.js';
import { StepError, TransientError } from '../domain/errors.js';
import {
  TERMINAL_RUN_STATUSES,
  type ApprovalRecord,
  type AttemptLogEntry,
  type NodeDef,
  type RunEndReason,
  type RunError,
  type RunRecord,
  type RunStatus,
  type StepRecord,
} from '../domain/types.js';
import { redactSecrets } from '../guardrails/redact.js';
import type { HandlerRegistry } from '../nodes/index.js';
import type { HandlerSettings, NodeResult } from '../nodes/types.js';
import type { AIProvider } from '../ports/ai-provider.js';
import type { Clock } from '../ports/clock.js';
import type { Repository } from '../ports/repository.js';
import type { WorldClient } from '../ports/world-client.js';
import { resolveTemplates, type TemplateContext } from '../templates/resolver.js';
import { backoffMs } from './retry.js';

export interface EngineSettings extends HandlerSettings {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxClaims: number;
  leaseMs: number;
  random?: () => number;
}

export interface EngineDeps {
  repo: Repository;
  catalog: Catalog;
  handlers: HandlerRegistry;
  world: WorldClient;
  ai?: AIProvider;
  clock: Clock;
  settings: EngineSettings;
}

/** Why `advance` returned: the claim is over in every case. */
export type AdvanceOutcome = 'finished' | 'waiting' | 'requeued' | 'lost_lease' | 'noop';

class LeaseLostError extends Error {}

const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_approval'];
const MAX_TRANSITIONS_PER_CLAIM = 500;

/**
 * Durable run state machine. The worker holds a lease on the run's job and calls `advance`;
 * every decision is derived from persisted steps, so a fresh worker can resume any run.
 * Side effects follow persist → act → persist with an idempotency key fixed at step creation.
 */
export class Engine {
  constructor(private readonly deps: EngineDeps) {}

  async advance(runId: string, workerId: string, claimCount = 1): Promise<AdvanceOutcome> {
    try {
      const run = await this.deps.repo.getRun(runId);
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        await this.deps.repo.removeJob(runId);
        return 'noop';
      }
      if (claimCount > this.deps.settings.maxClaims) {
        return await this.finish(run, workerId, 'failed', 'failed', {
          code: 'poison_job',
          message: `Run abandoned after ${claimCount - 1} interrupted attempts (MAX_CLAIMS=${this.deps.settings.maxClaims})`,
        });
      }
      if (run.status === 'queued') {
        await this.inTx(runId, workerId, (tx) =>
          tx.updateRun(runId, { status: 'running', started_at: this.now() }, { fromStatuses: ['queued'] }),
        );
      }
      for (let i = 0; i < MAX_TRANSITIONS_PER_CLAIM; i++) {
        const outcome = await this.transition(runId, workerId);
        if (outcome) return outcome;
      }
      // Yield so other runs get a turn; the step cap still bounds the run itself.
      await this.inTx(runId, workerId, (tx) => tx.enqueueJob(runId, this.now(), { resetClaims: true }));
      return 'requeued';
    } catch (err) {
      if (err instanceof LeaseLostError) return 'lost_lease';
      throw err;
    }
  }

  /** Performs one state-machine transition. Returns an outcome when this claim must stop, or null to keep going. */
  private async transition(runId: string, workerId: string): Promise<AdvanceOutcome | null> {
    const { repo, catalog } = this.deps;
    const run = await repo.getRun(runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return 'noop';
    if (run.cancel_requested) return this.finish(run, workerId, 'cancelled', 'cancelled', null);

    const nodes = new Map(run.definition_snapshot.nodes.map((n) => [n.id, n]));
    const steps = await repo.listSteps(runId);
    const last = steps.at(-1);

    let node: NodeDef | undefined;
    let sequence: number;
    let existing: StepRecord | undefined;

    if (!last) {
      node = nodes.get(run.definition_snapshot.entry);
      sequence = 1;
    } else {
      switch (last.status) {
        case 'running':
          // Crash recovery: the step may or may not have reached the world. Re-run it with the same key.
          existing = last;
          node = nodes.get(last.node_id);
          sequence = last.sequence;
          break;
        case 'waiting':
          return this.resumeWaiting(run, last, nodes.get(last.node_id), workerId);
        case 'succeeded':
          if (last.next_node_id === null || last.next_node_id === undefined) {
            return this.finish(run, workerId, 'succeeded', 'completed', null);
          }
          node = nodes.get(last.next_node_id);
          sequence = last.sequence + 1;
          break;
        case 'failed':
          return this.finish(run, workerId, 'failed', 'failed', last.error ?? { code: 'step_failed', message: `Node '${last.node_id}' failed` });
        case 'cancelled':
          return this.finish(run, workerId, 'cancelled', 'cancelled', null);
      }
    }

    if (!node) {
      return this.finish(run, workerId, 'failed', 'failed', { code: 'unknown_node', message: 'Definition snapshot references a missing node' });
    }

    if (!existing) {
      const maxSteps = run.definition_snapshot.limits.max_steps;
      if (run.steps_executed >= maxSteps) {
        return this.finish(run, workerId, 'failed', 'cap_exceeded', {
          code: 'max_steps_exceeded',
          message: `Step cap reached: max_steps=${maxSteps} exceeded before node '${node.id}'`,
          node_id: node.id,
        });
      }
    }

    // Approval gate: a database fact, checked on every execution of a sensitive node. No model output can set it.
    const approvalGranted = catalog.requiresApproval(node.type) ? await repo.hasApprovedApproval(run.id) : false;
    if (catalog.requiresApproval(node.type) && !approvalGranted) {
      return this.failAtNode(run, node, sequence, existing, workerId, {
        code: 'approval_required',
        message: `Node '${node.id}' (${node.type}) requires an approved approval earlier in this run; none exists`,
        node_id: node.id,
      });
    }

    let params: Record<string, unknown>;
    try {
      params = resolveTemplates(node.params ?? {}, templateContext(run, steps)) as Record<string, unknown>;
    } catch (err) {
      if (!(err instanceof StepError)) throw err;
      return this.failAtNode(run, node, sequence, existing, workerId, { code: err.code, message: err.message, node_id: node.id });
    }

    let step: StepRecord;
    if (existing) {
      step = existing;
    } else {
      step = {
        run_id: run.id,
        sequence,
        node_id: node.id,
        node_type: node.type,
        status: 'running',
        attempt: 1,
        attempts_log: [],
        resolved_input: redactSecrets(params),
        idempotency_key: catalog.isSideEffect(node.type) ? `${run.id}:${node.id}:${sequence}` : undefined,
        started_at: this.now(),
      };
      // Persist BEFORE acting: from here on, a crash re-executes this exact step with this exact key.
      await this.inTx(run.id, workerId, async (tx) => {
        await tx.insertStep(step);
        await tx.updateRun(run.id, { current_node_id: node.id }, { inc: { steps_executed: 1 } });
      });
    }

    const handler = this.deps.handlers[node.type];
    const attemptStartedAt = this.now();
    let result: NodeResult;
    try {
      if (!handler) throw new TransientError('handler_missing', `No handler registered for node type '${node.type}'`);
      result = await handler.execute({
        run,
        node,
        params,
        sequence: step.sequence,
        attempt: step.attempt,
        idempotencyKey: step.idempotency_key,
        stepStartedAt: step.started_at,
        now: attemptStartedAt,
        approvalGranted,
        world: this.deps.world,
        ai: this.deps.ai,
        settings: this.deps.settings,
      });
    } catch (err) {
      const stepError = err instanceof StepError ? err : new TransientError('handler_error', err instanceof Error ? err.message : String(err));
      return this.onStepError(run, node, step, stepError, attemptStartedAt, workerId);
    }
    return this.onStepResult(run, node, step, result, attemptStartedAt, workerId);
  }

  private async onStepResult(
    run: RunRecord,
    node: NodeDef,
    step: StepRecord,
    result: NodeResult,
    attemptStartedAt: Date,
    workerId: string,
  ): Promise<AdvanceOutcome | null> {
    const now = this.now();
    const attemptsLog = [...step.attempts_log, this.attemptEntry(step.attempt, attemptStartedAt, now)];

    switch (result.kind) {
      case 'completed': {
        const next = result.next !== undefined ? result.next : (node.next ?? null);
        await this.inTx(run.id, workerId, async (tx) => {
          await tx.updateStep(run.id, step.sequence, {
            status: 'succeeded',
            output: result.output,
            next_node_id: next,
            attempts_log: attemptsLog,
            tokens_prompt: result.tokens?.prompt,
            tokens_completion: result.tokens?.completion,
            ai_attempts: result.aiAttempts,
            finished_at: now,
            duration_ms: now.getTime() - step.started_at.getTime(),
          });
          if (result.tokens) {
            await tx.updateRun(run.id, {}, { inc: { ai_tokens_used: result.tokens.prompt + result.tokens.completion } });
          }
        });
        return null;
      }
      case 'wait_delay':
        await this.inTx(run.id, workerId, async (tx) => {
          await tx.updateStep(run.id, step.sequence, { status: 'waiting', resume_at: result.resumeAt });
          await tx.enqueueJob(run.id, result.resumeAt, { resetClaims: true });
        });
        return 'requeued';
      case 'wait_approval': {
        const approval: ApprovalRecord = {
          id: `apr_${ulid()}`,
          run_id: run.id,
          node_id: node.id,
          step_sequence: step.sequence,
          message: result.message,
          status: 'pending',
          created_at: now,
        };
        await this.inTx(run.id, workerId, async (tx) => {
          const stored = await tx.insertApproval(approval);
          await tx.updateStep(run.id, step.sequence, { status: 'waiting', approval_id: stored.id, attempts_log: attemptsLog });
          await tx.updateRun(run.id, { status: 'waiting_approval' }, { fromStatuses: ['running'] });
          await tx.removeJob(run.id);
        });
        return 'waiting';
      }
    }
  }

  private async onStepError(
    run: RunRecord,
    node: NodeDef,
    step: StepRecord,
    err: StepError,
    attemptStartedAt: Date,
    workerId: string,
  ): Promise<AdvanceOutcome> {
    const { settings } = this.deps;
    const now = this.now();
    const attemptsLog = [...step.attempts_log, this.attemptEntry(step.attempt, attemptStartedAt, now, err)];

    if (err.retryable && step.attempt < settings.maxAttempts) {
      const retryAt = new Date(now.getTime() + backoffMs(step.attempt, settings.backoffBaseMs, settings.backoffMaxMs, settings.random));
      await this.inTx(run.id, workerId, async (tx) => {
        await tx.updateStep(run.id, step.sequence, { attempt: step.attempt + 1, attempts_log: attemptsLog });
        await tx.enqueueJob(run.id, retryAt, { resetClaims: true });
      });
      return 'requeued';
    }

    const exhausted = err.retryable ? ` (gave up after ${step.attempt} attempts)` : '';
    const error: RunError = { code: err.code, message: `${err.message}${exhausted}`, node_id: node.id };
    await this.inTx(run.id, workerId, async (tx) => {
      await tx.updateStep(run.id, step.sequence, {
        status: 'failed',
        error,
        attempts_log: attemptsLog,
        tokens_prompt: err.trace?.tokens?.prompt,
        tokens_completion: err.trace?.tokens?.completion,
        ai_attempts: err.trace?.aiAttempts,
        finished_at: now,
        duration_ms: now.getTime() - step.started_at.getTime(),
      });
      if (err.trace?.tokens) {
        await tx.updateRun(run.id, {}, { inc: { ai_tokens_used: err.trace.tokens.prompt + err.trace.tokens.completion } });
      }
      await this.finishInTx(tx, run.id, 'failed', 'failed', error);
    });
    return 'finished';
  }

  private async resumeWaiting(run: RunRecord, step: StepRecord, node: NodeDef | undefined, workerId: string): Promise<AdvanceOutcome | null> {
    const now = this.now();
    const complete = (output: unknown) =>
      this.inTx(run.id, workerId, (tx) =>
        tx.updateStep(run.id, step.sequence, {
          status: 'succeeded',
          output,
          next_node_id: node?.next ?? null,
          finished_at: now,
          duration_ms: now.getTime() - step.started_at.getTime(),
        }),
      );

    if (step.node_type === 'delay') {
      if (step.resume_at && now < step.resume_at) {
        await this.inTx(run.id, workerId, (tx) => tx.enqueueJob(run.id, step.resume_at!, { resetClaims: true }));
        return 'requeued';
      }
      await complete({ waited_seconds: Math.round((now.getTime() - step.started_at.getTime()) / 1000), resumed_at: now.toISOString() });
      return null;
    }

    const approval = step.approval_id ? await this.deps.repo.getApproval(step.approval_id) : null;
    if (approval?.status === 'approved') {
      await complete({ decision: 'approved', decided_by: approval.decided_by ?? null });
      return null;
    }
    if (approval?.status === 'rejected' || approval?.status === 'closed') {
      return this.finish(run, workerId, 'cancelled', 'rejected', null);
    }
    await this.inTx(run.id, workerId, async (tx) => {
      await tx.updateRun(run.id, { status: 'waiting_approval' }, { fromStatuses: ['running'] });
      await tx.removeJob(run.id);
    });
    return 'waiting';
  }

  /** Records a failure that happened before the node could act (gate, template) as a failed step, then fails the run. */
  private async failAtNode(
    run: RunRecord,
    node: NodeDef,
    sequence: number,
    existing: StepRecord | undefined,
    workerId: string,
    error: RunError,
  ): Promise<AdvanceOutcome> {
    const now = this.now();
    await this.inTx(run.id, workerId, async (tx) => {
      if (existing) {
        await tx.updateStep(run.id, sequence, { status: 'failed', error, finished_at: now, duration_ms: now.getTime() - existing.started_at.getTime() });
      } else {
        await tx.insertStep({
          run_id: run.id,
          sequence,
          node_id: node.id,
          node_type: node.type,
          status: 'failed',
          attempt: 1,
          attempts_log: [],
          resolved_input: null,
          error,
          started_at: now,
          finished_at: now,
          duration_ms: 0,
        });
        await tx.updateRun(run.id, { current_node_id: node.id }, { inc: { steps_executed: 1 } });
      }
      await this.finishInTx(tx, run.id, 'failed', 'failed', error);
    });
    return 'finished';
  }

  private async finish(
    run: RunRecord,
    workerId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    endedBy: RunEndReason,
    error: RunError | null,
  ): Promise<AdvanceOutcome> {
    await this.inTx(run.id, workerId, (tx) => this.finishInTx(tx, run.id, status, endedBy, error));
    return 'finished';
  }

  private async finishInTx(
    tx: Repository,
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    endedBy: RunEndReason,
    error: RunError | null,
  ): Promise<void> {
    await tx.updateRun(runId, { status, ended_by: endedBy, error, finished_at: this.now() }, { fromStatuses: ACTIVE_STATUSES });
    if (status === 'cancelled') {
      for (const approval of await tx.listApprovals({ run_id: runId, status: 'pending' })) {
        await tx.updateApproval(approval.id, { status: 'closed' }, ['pending']);
      }
      const last = await tx.getLastStep(runId);
      if (last?.status === 'waiting') {
        await tx.updateStep(runId, last.sequence, { status: 'cancelled', finished_at: this.now() }, ['waiting']);
      }
    }
    await tx.removeJob(runId);
  }

  /** Every engine write runs in a transaction that first renews this worker's lease (fencing). */
  private async inTx<T>(runId: string, workerId: string, fn: (tx: Repository) => Promise<T>): Promise<T> {
    return this.deps.repo.transaction(async (tx) => {
      const now = this.now();
      if (!(await tx.renewJobLease(runId, workerId, now, new Date(now.getTime() + this.deps.settings.leaseMs)))) {
        throw new LeaseLostError(`Lease on ${runId} lost by ${workerId}`);
      }
      return fn(tx);
    });
  }

  private attemptEntry(attempt: number, startedAt: Date, finishedAt: Date, err?: StepError): AttemptLogEntry {
    const entry: AttemptLogEntry = { attempt, started_at: startedAt, duration_ms: finishedAt.getTime() - startedAt.getTime() };
    if (err) {
      entry.error = `${err.code}: ${err.message}`;
      if (err.statusCode !== undefined) entry.status_code = err.statusCode;
    }
    return entry;
  }

  private now(): Date {
    return this.deps.clock.now();
  }
}

/** Template scope: the trigger body plus the latest successful output of each node (loops overwrite). */
function templateContext(run: RunRecord, steps: StepRecord[]): TemplateContext {
  const nodes: TemplateContext['nodes'] = {};
  for (const s of steps) {
    if (s.status === 'succeeded') nodes[s.node_id] = { output: s.output };
  }
  return { trigger: { body: run.input }, nodes };
}
