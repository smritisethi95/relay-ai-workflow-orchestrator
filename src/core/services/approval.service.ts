import { DomainError } from '../domain/errors.js';
import type { ApprovalRecord, ApprovalStatus } from '../domain/types.js';
import { assertValidId } from '../guardrails/ids.js';
import { systemClock, type Clock } from '../ports/clock.js';
import type { Repository } from '../ports/repository.js';

const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'closed'];
const MAX_COMMENT = 1000;

export interface ApprovalView extends ApprovalRecord {
  workflow_id: string | null;
}

/**
 * The only writer of approval decisions. Approve resumes the run; reject ends it `cancelled`.
 * Each decision is one transaction guarded on `status = 'pending'`, so a second decision gets 409.
 */
export class ApprovalService {
  constructor(
    private readonly repo: Repository,
    private readonly clock: Clock = systemClock,
  ) {}

  async list(status: unknown): Promise<ApprovalView[]> {
    if (status !== undefined && !(typeof status === 'string' && (APPROVAL_STATUSES as readonly string[]).includes(status))) {
      throw new DomainError('invalid_query', `status must be one of: ${APPROVAL_STATUSES.join(', ')}`, 400);
    }
    const approvals = await this.repo.listApprovals({ status: status as ApprovalStatus | undefined, limit: 200 });
    return Promise.all(approvals.map((a) => this.withWorkflow(a)));
  }

  async get(id: string): Promise<ApprovalView> {
    return this.withWorkflow(await this.find(id));
  }

  async approve(id: string, decidedBy: string, comment?: unknown): Promise<ApprovalView> {
    const note = parseComment(comment);
    await this.findPending(id);
    const now = this.clock.now();

    const decided = await this.repo.transaction(async (tx) => {
      const approval = await tx.updateApproval(id, { status: 'approved', decided_by: decidedBy, decided_at: now, comment: note }, ['pending']);
      if (!approval) throw alreadyDecided(id);
      const run = await tx.getRun(approval.run_id);
      if (!run) throw new DomainError('not_found', `Run '${approval.run_id}' not found`, 404);

      const node = run.definition_snapshot.nodes.find((n) => n.id === approval.node_id);
      const step = (await tx.listSteps(run.id)).find((s) => s.sequence === approval.step_sequence);
      await tx.updateStep(
        run.id,
        approval.step_sequence,
        {
          status: 'succeeded',
          output: { decision: 'approved', decided_by: decidedBy },
          next_node_id: node?.next ?? null,
          finished_at: now,
          duration_ms: step ? now.getTime() - step.started_at.getTime() : undefined,
        },
        ['waiting'],
      );
      await tx.updateRun(run.id, { status: 'running' }, { fromStatuses: ['waiting_approval'] });
      await tx.enqueueJob(run.id, now, { resetClaims: true });
      return approval;
    });
    return this.withWorkflow(decided);
  }

  async reject(id: string, decidedBy: string, comment?: unknown): Promise<ApprovalView> {
    const note = parseComment(comment);
    await this.findPending(id);
    const now = this.clock.now();

    const decided = await this.repo.transaction(async (tx) => {
      const approval = await tx.updateApproval(id, { status: 'rejected', decided_by: decidedBy, decided_at: now, comment: note }, ['pending']);
      if (!approval) throw alreadyDecided(id);
      await tx.updateStep(
        approval.run_id,
        approval.step_sequence,
        { status: 'cancelled', output: { decision: 'rejected', decided_by: decidedBy }, finished_at: now },
        ['waiting'],
      );
      await tx.updateRun(
        approval.run_id,
        { status: 'cancelled', ended_by: 'rejected', finished_at: now },
        { fromStatuses: ['waiting_approval', 'running', 'queued'] },
      );
      await tx.removeJob(approval.run_id);
      return approval;
    });
    return this.withWorkflow(decided);
  }

  private async find(id: string): Promise<ApprovalRecord> {
    assertValidId(id, 'Approval');
    const approval = await this.repo.getApproval(id);
    if (!approval) throw new DomainError('not_found', `Approval '${id}' not found`, 404);
    return approval;
  }

  private async findPending(id: string): Promise<ApprovalRecord> {
    const approval = await this.find(id);
    if (approval.status !== 'pending') throw alreadyDecided(id, approval.status);
    return approval;
  }

  private async withWorkflow(approval: ApprovalRecord): Promise<ApprovalView> {
    const run = await this.repo.getRun(approval.run_id);
    return { ...approval, workflow_id: run?.workflow_id ?? null };
  }
}

function alreadyDecided(id: string, status?: ApprovalStatus): DomainError {
  return new DomainError('approval_already_decided', `Approval '${id}' is already ${status ?? 'decided'}`, 409);
}

function parseComment(comment: unknown): string | undefined {
  if (comment === undefined || comment === null || comment === '') return undefined;
  if (typeof comment !== 'string') throw new DomainError('invalid_input', 'comment must be a string', 400);
  return comment.slice(0, MAX_COMMENT);
}
