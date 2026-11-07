import { DomainError } from '../domain/errors.js';
import { RUN_STATUSES, TERMINAL_RUN_STATUSES, type RunRecord, type RunStatus, type StepRecord } from '../domain/types.js';
import { assertValidId } from '../guardrails/ids.js';
import { systemClock, type Clock } from '../ports/clock.js';
import type { Repository, RunSummary } from '../ports/repository.js';

export interface RunWithSteps {
  run: RunRecord;
  steps: StepRecord[];
}

export class RunService {
  constructor(
    private readonly repo: Repository,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(id: string): Promise<RunWithSteps> {
    assertValidId(id, 'Run');
    const run = await this.repo.getRun(id);
    if (!run) throw new DomainError('not_found', `Run '${id}' not found`, 404);
    return { run, steps: await this.repo.listSteps(id) };
  }

  async list(query: { workflow_id?: unknown; status?: unknown; limit?: unknown }): Promise<RunSummary[]> {
    const filter: { workflow_id?: string; status?: RunStatus; limit?: number } = {};
    if (query.workflow_id !== undefined) {
      assertValidId(query.workflow_id, 'Workflow');
      filter.workflow_id = query.workflow_id;
    }
    if (query.status !== undefined) {
      if (typeof query.status !== 'string' || !(RUN_STATUSES as readonly string[]).includes(query.status)) {
        throw new DomainError('invalid_query', `status must be one of: ${RUN_STATUSES.join(', ')}`, 400);
      }
      filter.status = query.status as RunStatus;
    }
    if (query.limit !== undefined) {
      const limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError('invalid_query', 'limit must be 1..200', 400);
      filter.limit = limit;
    }
    return this.repo.listRuns(filter);
  }

  /**
   * queued / waiting_approval → cancelled immediately (approval closed).
   * running → cancel_requested; the engine stops between steps and the in-flight step finishes.
   * terminal → 409.
   */
  async cancel(id: string): Promise<RunRecord> {
    // A few attempts because the worker may move the run between our read and our guarded write.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { run } = await this.get(id);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new DomainError('run_already_terminal', `Run '${id}' is already ${run.status}`, 409);
      }
      const now = this.clock.now();

      if (run.status === 'queued' || run.status === 'waiting_approval') {
        const done = await this.repo.transaction(async (tx) => {
          const changed = await tx.updateRun(
            id,
            { status: 'cancelled', cancel_requested: true, ended_by: 'cancelled', finished_at: now },
            { fromStatuses: [run.status] },
          );
          if (!changed) return false;
          for (const approval of await tx.listApprovals({ run_id: id, status: 'pending' })) {
            await tx.updateApproval(approval.id, { status: 'closed' }, ['pending']);
          }
          const last = await tx.getLastStep(id);
          if (last?.status === 'waiting') await tx.updateStep(id, last.sequence, { status: 'cancelled', finished_at: now }, ['waiting']);
          await tx.removeJob(id);
          return true;
        });
        if (done) return (await this.repo.getRun(id))!;
        continue;
      }

      if (await this.repo.updateRun(id, { cancel_requested: true }, { fromStatuses: ['running'] })) {
        await this.repo.expediteJob(id, now);
        return (await this.repo.getRun(id))!;
      }
    }
    throw new DomainError('conflict', `Run '${id}' changed state while cancelling; retry`, 409);
  }
}
