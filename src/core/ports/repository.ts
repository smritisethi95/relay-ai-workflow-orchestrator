import type {
  ApprovalRecord,
  ApprovalStatus,
  RunRecord,
  RunStatus,
  StepRecord,
  StepStatus,
  WorkflowRecord,
} from '../domain/types.js';

export interface RunFilter {
  workflow_id?: string;
  status?: RunStatus;
  limit?: number;
}

export interface ApprovalFilter {
  status?: ApprovalStatus;
  run_id?: string;
  limit?: number;
}

export type RunSummary = Omit<RunRecord, 'definition_snapshot' | 'input'>;
export type WorkflowPatch = Partial<Omit<WorkflowRecord, 'id' | 'created_at'>>;
export type RunPatch = Partial<Omit<RunRecord, 'id' | 'workflow_id' | 'definition_snapshot' | 'created_at'>>;
export type StepPatch = Partial<Omit<StepRecord, 'run_id' | 'sequence' | 'node_id' | 'node_type'>>;
export type ApprovalPatch = Partial<Pick<ApprovalRecord, 'status' | 'decided_by' | 'decided_at' | 'comment'>>;

export interface RunUpdateOptions {
  /** Only update when the run is currently in one of these statuses (guarded transition). */
  fromStatuses?: readonly RunStatus[];
  inc?: { steps_executed?: number; ai_tokens_used?: number };
}

/**
 * Persistence port for the engine and services. Implementations: MongoRepository (production),
 * InMemoryRepository (tests).
 */
export interface Repository {
  /** Runs `fn` atomically. `fn` may be retried on transient conflicts, so it must only touch `tx`. */
  transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T>;

  /** Returns false when a workflow with the same id already exists. */
  insertWorkflow(workflow: WorkflowRecord): Promise<boolean>;
  /** Inserts only if absent (seeding); returns true when inserted. */
  insertWorkflowIfAbsent(workflow: WorkflowRecord): Promise<boolean>;
  getWorkflow(id: string): Promise<WorkflowRecord | null>;
  listWorkflows(): Promise<WorkflowRecord[]>;
  /** Optimistic update: applies only if `updated_at` still equals `expectedUpdatedAt`. */
  updateWorkflow(id: string, expectedUpdatedAt: Date, patch: WorkflowPatch): Promise<boolean>;

  insertRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(filter: RunFilter): Promise<RunSummary[]>;
  /** Returns false when the run does not exist or is not in `fromStatuses`. */
  updateRun(id: string, patch: RunPatch, options?: RunUpdateOptions): Promise<boolean>;

  insertStep(step: StepRecord): Promise<void>;
  listSteps(runId: string): Promise<StepRecord[]>;
  getLastStep(runId: string): Promise<StepRecord | null>;
  updateStep(runId: string, sequence: number, patch: StepPatch, fromStatuses?: readonly StepStatus[]): Promise<boolean>;

  /** Idempotent on (run_id, node_id, step_sequence): returns the existing approval if already created. */
  insertApproval(approval: ApprovalRecord): Promise<ApprovalRecord>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  listApprovals(filter: ApprovalFilter): Promise<ApprovalRecord[]>;
  /** Conditional update; returns the updated approval, or null if it was not in `fromStatuses`. */
  updateApproval(id: string, patch: ApprovalPatch, fromStatuses: readonly ApprovalStatus[]): Promise<ApprovalRecord | null>;
  hasApprovedApproval(runId: string): Promise<boolean>;

  /** Upsert: makes the run's single job available at `availableAt` and clears any lease. */
  enqueueJob(runId: string, availableAt: Date, options?: { resetClaims?: boolean }): Promise<void>;
  removeJob(runId: string): Promise<void>;
  /** Makes an unleased job claimable now (e.g. a run sleeping on a delay that was just cancelled). No-op while leased. */
  expediteJob(runId: string, now: Date): Promise<void>;
  /** Fencing + heartbeat: extends the lease only while `workerId` still holds it; false means the lease was lost. */
  renewJobLease(runId: string, workerId: string, now: Date, lockedUntil: Date): Promise<boolean>;
}
