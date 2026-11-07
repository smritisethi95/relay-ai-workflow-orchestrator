import { ulid } from 'ulid';
import { DomainError } from '../domain/errors.js';
import type { RunRecord, TriggerType } from '../domain/types.js';
import { assertValidId } from '../guardrails/ids.js';
import { findUnsafeKey } from '../guardrails/safe-keys.js';
import { secretsMatch } from '../guardrails/secrets.js';
import { systemClock, type Clock } from '../ports/clock.js';
import type { Repository } from '../ports/repository.js';

/** Creates runs. Never executes anything: it snapshots the published definition and enqueues a job atomically. */
export class TriggerService {
  constructor(
    private readonly repo: Repository,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Manual/API trigger. Allowed for any published workflow (handy for demos and tests). */
  async triggerManual(workflowId: string, input: unknown): Promise<RunRecord> {
    return this.createRun(workflowId, input, 'manual');
  }

  /** Webhook trigger: the workflow must declare a webhook trigger and the secret must match (constant time). */
  async triggerWebhook(workflowId: string, secret: string | undefined, body: unknown): Promise<RunRecord> {
    assertValidId(workflowId, 'Workflow');
    const workflow = await this.repo.getWorkflow(workflowId);
    if (!workflow) throw new DomainError('not_found', `Workflow '${workflowId}' not found`, 404);
    const definition = workflow.published_definition ?? workflow.draft_definition;
    if (definition.trigger?.type !== 'webhook') {
      throw new DomainError('trigger_type_mismatch', `Workflow '${workflowId}' does not accept webhooks`, 409);
    }
    if (!secret || !secretsMatch(secret, definition.trigger.secret)) {
      throw new DomainError('invalid_webhook_secret', 'Missing or invalid X-Relay-Secret', 401);
    }
    return this.createRun(workflowId, body, 'webhook');
  }

  private async createRun(workflowId: string, input: unknown, triggerType: TriggerType): Promise<RunRecord> {
    assertValidId(workflowId, 'Workflow');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new DomainError('invalid_input', 'Trigger input must be a JSON object', 400);
    }
    const unsafe = findUnsafeKey(input);
    if (unsafe) throw new DomainError('invalid_key', `Key '${unsafe}' is not allowed in trigger input`, 400);

    const workflow = await this.repo.getWorkflow(workflowId);
    if (!workflow) throw new DomainError('not_found', `Workflow '${workflowId}' not found`, 404);
    if (!workflow.published_definition) {
      throw new DomainError('workflow_not_published', `Workflow '${workflowId}' has not been published`, 409);
    }

    const now = this.clock.now();
    const run: RunRecord = {
      id: `run_${ulid()}`,
      workflow_id: workflow.id,
      workflow_version: workflow.version,
      definition_snapshot: workflow.published_definition,
      status: 'queued',
      trigger_type: triggerType,
      input: input as Record<string, unknown>,
      current_node_id: null,
      steps_executed: 0,
      ai_tokens_used: 0,
      cancel_requested: false,
      error: null,
      ended_by: null,
      created_at: now,
      updated_at: now,
    };
    await this.repo.transaction(async (tx) => {
      await tx.insertRun(run);
      await tx.enqueueJob(run.id, now, { resetClaims: true });
    });
    return run;
  }
}
