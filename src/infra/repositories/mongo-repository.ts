import type { ClientSession, Collection, Db, Filter, UpdateFilter } from 'mongodb';
import type {
  ApprovalRecord,
  ApprovalStatus,
  RunRecord,
  StepRecord,
  StepStatus,
  WorkflowRecord,
} from '../../core/domain/types.js';
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
} from '../../core/ports/repository.js';
import { COLLECTIONS, isDuplicateKeyError, withTransaction } from '../db/mongo.js';

type Doc<T extends { id: string }> = Omit<T, 'id'> & { _id: string };
type WorkflowDoc = Doc<WorkflowRecord>;
type RunDoc = Doc<RunRecord>;
type ApprovalDoc = Doc<ApprovalRecord>;
type StepDoc = StepRecord;

export interface JobDoc {
  _id: string;
  available_at: Date;
  locked_by: string | null;
  locked_until: Date | null;
  claim_count: number;
  created_at: Date;
}

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

function toDoc<T extends { id: string }>(record: T): Doc<T> {
  const { id, ...rest } = record;
  return { _id: id, ...rest } as unknown as Doc<T>;
}

function fromDoc<T extends { id: string }>(doc: Doc<T> | null): T | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest } as unknown as T;
}

function limitOf(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
}

export class MongoRepository implements Repository {
  private readonly workflows: Collection<WorkflowDoc>;
  private readonly runs: Collection<RunDoc>;
  private readonly steps: Collection<StepDoc>;
  private readonly approvals: Collection<ApprovalDoc>;
  private readonly jobs: Collection<JobDoc>;

  constructor(
    private readonly db: Db,
    private readonly session?: ClientSession,
  ) {
    this.workflows = db.collection<WorkflowDoc>(COLLECTIONS.workflows);
    this.runs = db.collection<RunDoc>(COLLECTIONS.runs);
    this.steps = db.collection<StepDoc>(COLLECTIONS.steps);
    this.approvals = db.collection<ApprovalDoc>(COLLECTIONS.approvals);
    this.jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  }

  private get opts(): { session?: ClientSession } {
    return this.session ? { session: this.session } : {};
  }

  async transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T> {
    if (this.session) return fn(this);
    return withTransaction((session) => fn(new MongoRepository(this.db, session)));
  }

  // ── workflows ──────────────────────────────────────────────────────────

  async insertWorkflow(workflow: WorkflowRecord): Promise<boolean> {
    try {
      await this.workflows.insertOne(toDoc(workflow), this.opts);
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async insertWorkflowIfAbsent(workflow: WorkflowRecord): Promise<boolean> {
    const { _id, ...rest } = toDoc(workflow);
    const result = await this.workflows.updateOne(
      { _id },
      { $setOnInsert: rest } as UpdateFilter<WorkflowDoc>,
      { upsert: true, ...this.opts },
    );
    return result.upsertedCount > 0;
  }

  async getWorkflow(id: string): Promise<WorkflowRecord | null> {
    return fromDoc<WorkflowRecord>(await this.workflows.findOne({ _id: id }, this.opts));
  }

  async listWorkflows(): Promise<WorkflowRecord[]> {
    const docs = await this.workflows.find({}, this.opts).sort({ _id: 1 }).toArray();
    return docs.map((d) => fromDoc<WorkflowRecord>(d)!);
  }

  async updateWorkflow(id: string, expectedUpdatedAt: Date, patch: WorkflowPatch): Promise<boolean> {
    const result = await this.workflows.updateOne(
      { _id: id, updated_at: expectedUpdatedAt },
      { $set: patch } as UpdateFilter<WorkflowDoc>,
      this.opts,
    );
    return result.matchedCount > 0;
  }

  // ── runs ───────────────────────────────────────────────────────────────

  async insertRun(run: RunRecord): Promise<void> {
    await this.runs.insertOne(toDoc(run), this.opts);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    return fromDoc<RunRecord>(await this.runs.findOne({ _id: id }, this.opts));
  }

  async listRuns(filter: RunFilter): Promise<RunSummary[]> {
    const query: Filter<RunDoc> = {};
    if (filter.workflow_id) query.workflow_id = filter.workflow_id;
    if (filter.status) query.status = filter.status;
    const docs = await this.runs
      .find(query, { ...this.opts, projection: { definition_snapshot: 0, input: 0 } })
      .sort({ created_at: -1 })
      .limit(limitOf(filter.limit))
      .toArray();
    return docs.map((d) => fromDoc<RunRecord>(d as RunDoc)! as RunSummary);
  }

  async updateRun(id: string, patch: RunPatch, options: RunUpdateOptions = {}): Promise<boolean> {
    const query: Filter<RunDoc> = { _id: id };
    if (options.fromStatuses) query.status = { $in: [...options.fromStatuses] };
    const update: Record<string, unknown> = { $set: { ...patch, updated_at: new Date() } };
    if (options.inc) update.$inc = options.inc;
    const result = await this.runs.updateOne(query, update as UpdateFilter<RunDoc>, this.opts);
    return result.matchedCount > 0;
  }

  // ── steps ──────────────────────────────────────────────────────────────

  async insertStep(step: StepRecord): Promise<void> {
    await this.steps.insertOne({ ...step }, this.opts);
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return this.steps.find({ run_id: runId }, { ...this.opts, projection: { _id: 0 } }).sort({ sequence: 1 }).toArray();
  }

  async getLastStep(runId: string): Promise<StepRecord | null> {
    return this.steps.findOne({ run_id: runId }, { ...this.opts, projection: { _id: 0 }, sort: { sequence: -1 } });
  }

  async updateStep(runId: string, sequence: number, patch: StepPatch, fromStatuses?: readonly StepStatus[]): Promise<boolean> {
    const query: Filter<StepDoc> = { run_id: runId, sequence };
    if (fromStatuses) query.status = { $in: [...fromStatuses] };
    const result = await this.steps.updateOne(query, { $set: patch } as UpdateFilter<StepDoc>, this.opts);
    return result.matchedCount > 0;
  }

  // ── approvals ──────────────────────────────────────────────────────────

  async insertApproval(approval: ApprovalRecord): Promise<ApprovalRecord> {
    // Upsert instead of insert+catch: a duplicate-key error would abort the surrounding transaction.
    const { _id, ...rest } = toDoc(approval);
    const doc = await this.approvals.findOneAndUpdate(
      { run_id: approval.run_id, node_id: approval.node_id, step_sequence: approval.step_sequence },
      { $setOnInsert: { _id, ...rest } } as UpdateFilter<ApprovalDoc>,
      { upsert: true, returnDocument: 'after', ...this.opts },
    );
    return fromDoc<ApprovalRecord>(doc)!;
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    return fromDoc<ApprovalRecord>(await this.approvals.findOne({ _id: id }, this.opts));
  }

  async listApprovals(filter: ApprovalFilter): Promise<ApprovalRecord[]> {
    const query: Filter<ApprovalDoc> = {};
    if (filter.status) query.status = filter.status;
    if (filter.run_id) query.run_id = filter.run_id;
    const docs = await this.approvals.find(query, this.opts).sort({ created_at: 1 }).limit(limitOf(filter.limit)).toArray();
    return docs.map((d) => fromDoc<ApprovalRecord>(d)!);
  }

  async updateApproval(id: string, patch: ApprovalPatch, fromStatuses: readonly ApprovalStatus[]): Promise<ApprovalRecord | null> {
    const doc = await this.approvals.findOneAndUpdate(
      { _id: id, status: { $in: [...fromStatuses] } },
      { $set: patch } as UpdateFilter<ApprovalDoc>,
      { returnDocument: 'after', ...this.opts },
    );
    return fromDoc<ApprovalRecord>(doc);
  }

  async hasApprovedApproval(runId: string): Promise<boolean> {
    return (await this.approvals.countDocuments({ run_id: runId, status: 'approved' }, { ...this.opts, limit: 1 })) > 0;
  }

  // ── jobs ───────────────────────────────────────────────────────────────

  async enqueueJob(runId: string, availableAt: Date, options: { resetClaims?: boolean } = {}): Promise<void> {
    const set: Partial<JobDoc> = { available_at: availableAt, locked_by: null, locked_until: null };
    if (options.resetClaims) set.claim_count = 0;
    const setOnInsert: Partial<JobDoc> = { created_at: new Date() };
    if (!options.resetClaims) setOnInsert.claim_count = 0;
    await this.jobs.updateOne({ _id: runId }, { $set: set, $setOnInsert: setOnInsert }, { upsert: true, ...this.opts });
  }

  async removeJob(runId: string): Promise<void> {
    await this.jobs.deleteOne({ _id: runId }, this.opts);
  }

  async expediteJob(runId: string, now: Date): Promise<void> {
    await this.jobs.updateOne(
      { _id: runId, $or: [{ locked_until: null }, { locked_until: { $lt: now } }] },
      { $set: { available_at: now } },
      this.opts,
    );
  }

  async renewJobLease(runId: string, workerId: string, now: Date, lockedUntil: Date): Promise<boolean> {
    const result = await this.jobs.updateOne(
      { _id: runId, locked_by: workerId, locked_until: { $gt: now } },
      { $set: { locked_until: lockedUntil } },
      this.opts,
    );
    return result.matchedCount > 0;
  }
}
