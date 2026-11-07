import { redactSecrets } from '../core/guardrails/redact.js';
import type { StepRecord, WorkflowRecord } from '../core/domain/types.js';
import type { ValidationResult } from '../core/catalog/validator.js';
import type { RunSummary } from '../core/ports/repository.js';
import type { RunWithSteps } from '../core/services/run.service.js';

export function presentWorkflow(w: WorkflowRecord) {
  return redactSecrets({
    id: w.id,
    name: w.name,
    description: w.description ?? null,
    status: w.status,
    version: w.version,
    has_unpublished_changes:
      w.published_definition !== null && JSON.stringify(w.published_definition) !== JSON.stringify(w.draft_definition),
    published_at: w.published_at ?? null,
    created_at: w.created_at,
    updated_at: w.updated_at,
    draft_definition: w.draft_definition,
    published_definition: w.published_definition,
  });
}

export function presentValidation(v: ValidationResult) {
  return { ok: v.ok, errors: v.errors, warnings: v.warnings };
}

export function presentStep(s: StepRecord) {
  return redactSecrets({
    sequence: s.sequence,
    node_id: s.node_id,
    type: s.node_type,
    status: s.status,
    attempt: s.attempt,
    input: s.resolved_input,
    output: s.output ?? null,
    error: s.error ?? null,
    next: s.next_node_id ?? null,
    idempotency_key: s.idempotency_key ?? null,
    tokens: s.tokens_prompt !== undefined ? { prompt: s.tokens_prompt, completion: s.tokens_completion ?? 0 } : null,
    ai_attempts: s.ai_attempts ?? null,
    attempts_log: s.attempts_log,
    resume_at: s.resume_at ?? null,
    approval_id: s.approval_id ?? null,
    started_at: s.started_at,
    finished_at: s.finished_at ?? null,
    duration_ms: s.duration_ms ?? null,
  });
}

export function presentRun({ run, steps }: RunWithSteps) {
  return redactSecrets({
    run_id: run.id,
    workflow_id: run.workflow_id,
    workflow_version: run.workflow_version,
    status: run.status,
    trigger_type: run.trigger_type,
    input: run.input,
    current_node_id: run.current_node_id,
    steps_executed: run.steps_executed,
    max_steps: run.definition_snapshot.limits.max_steps,
    ai_tokens_used: run.ai_tokens_used,
    cancel_requested: run.cancel_requested,
    error: run.error,
    ended_by: run.ended_by,
    created_at: run.created_at,
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? null,
    steps: steps.map(presentStep),
  });
}

export function presentRunSummary(r: RunSummary) {
  return {
    run_id: r.id,
    workflow_id: r.workflow_id,
    workflow_version: r.workflow_version,
    status: r.status,
    trigger_type: r.trigger_type,
    steps_executed: r.steps_executed,
    error: r.error,
    created_at: r.created_at,
    finished_at: r.finished_at ?? null,
  };
}
