import type { ApprovalRecord, ApprovalStatus, RunRecord, StepRecord, StepStatus, WorkflowRecord } from '../../src/core/domain/types.js';
import type {
  ApprovalFilter,
  ApprovalPatch,
  Repository,
  RunFilter,
  RunPatch,
  RunSummary,
  RunUpdateOptions,
  StepPatch,
  WorkflowPatch,
} from '../../src/core/ports/repository.js';
import type { ClaimedJob, Queue } from '../../src/core/ports/queue.js';

interface Job {
  runId: string;
  available_at: Date;
  locked_by: string | null;
  locked_until: Date | null;
  claim_count: number;
}

interface State {
  workflows: Map<string, WorkflowRecord>;
  runs: Map<string, RunRecord>;
  steps: Map<string, StepRecord[]>;
  approvals: Map<string, ApprovalRecord>;
  jobs: Map<string, Job>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Single-process Repository + Queue for engine/service tests. Transactions roll back on error. */
export class InMemoryRepository implements Repository, Queue {
  private state: State = { workflows: new Map(), runs: new Map(), steps: new Map(), approvals: new Map(), jobs: new Map() };

  async transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T> {
    const snapshot = clone(this.state);
    try {
      return await fn(this);
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }

  async insertWorkflow(w: WorkflowRecord): Promise<boolean> {
    if (this.state.workflows.has(w.id)) return false;
    this.state.workflows.set(w.id, clone(w));
    return true;
  }

  async insertWorkflowIfAbsent(w: WorkflowRecord): Promise<boolean> {
    return this.insertWorkflow(w);
  }

  async getWorkflow(id: string) {
    return clone(this.state.workflows.get(id) ?? null);
  }

  async listWorkflows() {
    return [...this.state.workflows.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone);
  }

  async updateWorkflow(id: string, expectedUpdatedAt: Date, patch: WorkflowPatch): Promise<boolean> {
    const current = this.state.workflows.get(id);
    if (!current || current.updated_at.getTime() !== expectedUpdatedAt.getTime()) return false;
    this.state.workflows.set(id, { ...current, ...clone(patch) });
    return true;
  }

  async insertRun(run: RunRecord) {
    if (this.state.runs.has(run.id)) throw new Error(`duplicate run ${run.id}`);
    this.state.runs.set(run.id, clone(run));
  }

  async getRun(id: string) {
    return clone(this.state.runs.get(id) ?? null);
  }

  async listRuns(filter: RunFilter): Promise<RunSummary[]> {
    return [...this.state.runs.values()]
      .filter((r) => (!filter.workflow_id || r.workflow_id === filter.workflow_id) && (!filter.status || r.status === filter.status))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, filter.limit ?? 50)
      .map(({ definition_snapshot: _s, input: _i, ...summary }) => clone(summary));
  }

  async updateRun(id: string, patch: RunPatch, options: RunUpdateOptions = {}) {
    const run = this.state.runs.get(id);
    if (!run || (options.fromStatuses && !options.fromStatuses.includes(run.status))) return false;
    const next: RunRecord = { ...run, ...clone(stripUndefined(patch)), updated_at: new Date() };
    if (options.inc?.steps_executed) next.steps_executed += options.inc.steps_executed;
    if (options.inc?.ai_tokens_used) next.ai_tokens_used += options.inc.ai_tokens_used;
    this.state.runs.set(id, next);
    return true;
  }

  async insertStep(step: StepRecord) {
    const list = this.state.steps.get(step.run_id) ?? [];
    if (list.some((s) => s.sequence === step.sequence)) throw new Error(`duplicate step ${step.run_id}#${step.sequence}`);
    list.push(clone(step));
    this.state.steps.set(step.run_id, list);
  }

  async listSteps(runId: string) {
    return [...(this.state.steps.get(runId) ?? [])].sort((a, b) => a.sequence - b.sequence).map(clone);
  }

  async getLastStep(runId: string) {
    const list = await this.listSteps(runId);
    return list.at(-1) ?? null;
  }

  async updateStep(runId: string, sequence: number, patch: StepPatch, fromStatuses?: readonly StepStatus[]) {
    const list = this.state.steps.get(runId) ?? [];
    const index = list.findIndex((s) => s.sequence === sequence);
    if (index < 0 || (fromStatuses && !fromStatuses.includes(list[index]!.status))) return false;
    list[index] = { ...list[index]!, ...clone(stripUndefined(patch)) };
    return true;
  }

  async insertApproval(a: ApprovalRecord) {
    const existing = [...this.state.approvals.values()].find(
      (x) => x.run_id === a.run_id && x.node_id === a.node_id && x.step_sequence === a.step_sequence,
    );
    if (existing) return clone(existing);
    this.state.approvals.set(a.id, clone(a));
    return clone(a);
  }

  async getApproval(id: string) {
    return clone(this.state.approvals.get(id) ?? null);
  }

  async listApprovals(filter: ApprovalFilter) {
    return [...this.state.approvals.values()]
      .filter((a) => (!filter.status || a.status === filter.status) && (!filter.run_id || a.run_id === filter.run_id))
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, filter.limit ?? 50)
      .map(clone);
  }

  async updateApproval(id: string, patch: ApprovalPatch, fromStatuses: readonly ApprovalStatus[]) {
    const a = this.state.approvals.get(id);
    if (!a || !fromStatuses.includes(a.status)) return null;
    const next = { ...a, ...clone(stripUndefined(patch)) };
    this.state.approvals.set(id, next);
    return clone(next);
  }

  async hasApprovedApproval(runId: string) {
    return [...this.state.approvals.values()].some((a) => a.run_id === runId && a.status === 'approved');
  }

  async enqueueJob(runId: string, availableAt: Date, options: { resetClaims?: boolean } = {}) {
    const existing = this.state.jobs.get(runId);
    this.state.jobs.set(runId, {
      runId,
      available_at: availableAt,
      locked_by: null,
      locked_until: null,
      claim_count: options.resetClaims || !existing ? 0 : existing.claim_count,
    });
  }

  async removeJob(runId: string) {
    this.state.jobs.delete(runId);
  }

  async expediteJob(runId: string, now: Date) {
    const job = this.state.jobs.get(runId);
    if (job && (!job.locked_until || job.locked_until < now)) job.available_at = now;
  }

  async renewJobLease(runId: string, workerId: string, now: Date, lockedUntil: Date) {
    const job = this.state.jobs.get(runId);
    if (!job || job.locked_by !== workerId || !job.locked_until || job.locked_until <= now) return false;
    job.locked_until = lockedUntil;
    return true;
  }

  async claim(workerId: string, leaseMs: number, now: Date): Promise<ClaimedJob | null> {
    const ready = [...this.state.jobs.values()]
      .filter((j) => j.available_at <= now && (!j.locked_until || j.locked_until < now))
      .sort((a, b) => a.available_at.getTime() - b.available_at.getTime())[0];
    if (!ready) return null;
    ready.locked_by = workerId;
    ready.locked_until = new Date(now.getTime() + leaseMs);
    ready.claim_count += 1;
    return { runId: ready.runId, claimCount: ready.claim_count };
  }

  async release(runId: string, workerId: string, availableAt: Date) {
    const job = this.state.jobs.get(runId);
    if (job && job.locked_by === workerId) Object.assign(job, { available_at: availableAt, locked_by: null, locked_until: null });
  }

  /** Test helper: inspect a job without going through the ports. */
  peekJob(runId: string): Job | undefined {
    return clone(this.state.jobs.get(runId));
  }

  /** Test helper: earliest time any job becomes claimable (ignores leases). */
  nextJobAt(): Date | null {
    const times = [...this.state.jobs.values()].map((j) => Math.max(j.available_at.getTime(), j.locked_until?.getTime() ?? 0));
    return times.length ? new Date(Math.min(...times)) : null;
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
