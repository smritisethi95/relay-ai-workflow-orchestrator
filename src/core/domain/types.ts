export const RUN_STATUSES = ['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export type StepStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'closed';
export type WorkflowStatus = 'draft' | 'published';
export type TriggerType = 'webhook' | 'manual';
export type RunEndReason = 'completed' | 'failed' | 'cancelled' | 'rejected' | 'cap_exceeded';

export const NODE_TYPES = ['http_request', 'condition', 'delay', 'notify', 'ai', 'approval', 'order_action'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export type TriggerDef =
  | { type: 'webhook'; secret: string }
  | { type: 'manual' }
  | { type: 'schedule'; cron: string };

export interface WorkflowLimits {
  max_steps: number;
  timeout_seconds?: number;
  max_ai_tokens?: number;
}

export interface NodeDef {
  id: string;
  type: NodeType;
  params: Record<string, unknown>;
  next?: string | null;
  on_true?: string;
  on_false?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  trigger: TriggerDef;
  entry: string;
  limits: WorkflowLimits;
  nodes: NodeDef[];
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  draft_definition: WorkflowDefinition;
  published_definition: WorkflowDefinition | null;
  version: number;
  published_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface RunError {
  code: string;
  message: string;
  node_id?: string;
}

export interface RunRecord {
  id: string;
  workflow_id: string;
  workflow_version: number;
  definition_snapshot: WorkflowDefinition;
  status: RunStatus;
  trigger_type: TriggerType;
  input: Record<string, unknown>;
  current_node_id: string | null;
  steps_executed: number;
  ai_tokens_used: number;
  cancel_requested: boolean;
  error: RunError | null;
  ended_by: RunEndReason | null;
  created_at: Date;
  started_at?: Date;
  finished_at?: Date;
  updated_at: Date;
}

export interface AttemptLogEntry {
  attempt: number;
  started_at: Date;
  duration_ms: number;
  error?: string;
  status_code?: number;
}

export interface AiAttempt {
  raw: string;
  valid: boolean;
  errors?: string[];
}

export interface StepRecord {
  run_id: string;
  sequence: number;
  node_id: string;
  node_type: NodeType;
  status: StepStatus;
  attempt: number;
  attempts_log: AttemptLogEntry[];
  resolved_input: unknown;
  output?: unknown;
  error?: RunError;
  idempotency_key?: string;
  tokens_prompt?: number;
  tokens_completion?: number;
  ai_attempts?: AiAttempt[];
  resume_at?: Date;
  approval_id?: string;
  next_node_id?: string | null;
  started_at: Date;
  finished_at?: Date;
  duration_ms?: number;
}

export interface ApprovalRecord {
  id: string;
  run_id: string;
  node_id: string;
  step_sequence: number;
  message: string;
  status: ApprovalStatus;
  decided_by?: string;
  decided_at?: Date;
  comment?: string;
  created_at: Date;
}
