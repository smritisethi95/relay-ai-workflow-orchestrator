import type { Catalog } from '../catalog/catalog.js';
import { validateDefinition, type ValidationIssue, type ValidationResult } from '../catalog/validator.js';
import { DomainError } from '../domain/errors.js';
import type { WorkflowDefinition, WorkflowRecord } from '../domain/types.js';
import { assertValidId, ID_PATTERN } from '../guardrails/ids.js';
import { findUnsafeKey } from '../guardrails/safe-keys.js';
import { systemClock, type Clock } from '../ports/clock.js';
import type { Repository } from '../ports/repository.js';

export interface WorkflowSummary {
  id: string;
  name: string;
  status: WorkflowRecord['status'];
  version: number;
  trigger_type: string | null;
  has_unpublished_changes: boolean;
  published_at: Date | null;
  updated_at: Date;
}

export interface SavedDraft {
  workflow: WorkflowRecord;
  validation: ValidationResult;
}

export interface PublishResult {
  workflow: WorkflowRecord;
  warnings: ValidationIssue[];
}

/** Draft → publish lifecycle. Published definitions are frozen copies; edits only ever touch the draft. */
export class WorkflowService {
  constructor(
    private readonly repo: Repository,
    private readonly catalog: Catalog,
    private readonly clock: Clock = systemClock,
  ) {}

  async list(): Promise<WorkflowSummary[]> {
    return (await this.repo.listWorkflows()).map(summarize);
  }

  async get(id: string): Promise<WorkflowRecord> {
    assertValidId(id, 'Workflow');
    const workflow = await this.repo.getWorkflow(id);
    if (!workflow) throw new DomainError('not_found', `Workflow '${id}' not found`, 404);
    return workflow;
  }

  async create(input: unknown): Promise<SavedDraft> {
    const definition = assertDraftShape(input);
    const now = this.clock.now();
    const workflow: WorkflowRecord = {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      status: 'draft',
      draft_definition: definition,
      published_definition: null,
      version: 0,
      created_at: now,
      updated_at: now,
    };
    if (!(await this.repo.insertWorkflow(workflow))) {
      throw new DomainError('workflow_exists', `Workflow '${definition.id}' already exists`, 409);
    }
    return { workflow, validation: validateDefinition(definition, this.catalog) };
  }

  async updateDraft(id: string, input: unknown): Promise<SavedDraft> {
    const current = await this.get(id);
    const definition = assertDraftShape(input);
    if (definition.id !== id) {
      throw new DomainError('invalid_definition', `Definition id '${definition.id}' does not match path id '${id}'`, 400);
    }
    const now = this.clock.now();
    const patch = { name: definition.name, description: definition.description, draft_definition: definition, updated_at: now };
    if (!(await this.repo.updateWorkflow(id, current.updated_at, patch))) {
      throw new DomainError('workflow_modified', `Workflow '${id}' was modified concurrently; retry`, 409);
    }
    return { workflow: { ...current, ...patch }, validation: validateDefinition(definition, this.catalog) };
  }

  async publish(id: string): Promise<PublishResult> {
    const current = await this.get(id);
    const validation = validateDefinition(current.draft_definition, this.catalog);
    if (!validation.ok) {
      throw new DomainError('validation_failed', validation.errors[0]!.message, 422, validation.errors);
    }
    const now = this.clock.now();
    const patch = {
      status: 'published' as const,
      published_definition: current.draft_definition,
      version: current.version + 1,
      published_at: now,
      updated_at: now,
    };
    if (!(await this.repo.updateWorkflow(id, current.updated_at, patch))) {
      throw new DomainError('workflow_modified', `Workflow '${id}' was modified concurrently; retry`, 409);
    }
    return { workflow: { ...current, ...patch }, warnings: validation.warnings };
  }

  /** Loads seed definitions as published v1. Existing workflows are left untouched, so restarts are idempotent. */
  async seed(definitions: WorkflowDefinition[]): Promise<string[]> {
    const inserted: string[] = [];
    for (const definition of definitions) {
      const validation = validateDefinition(definition, this.catalog);
      if (!validation.ok) {
        throw new Error(`Seed workflow '${definition.id}' is invalid: ${validation.errors.map((e) => e.message).join('; ')}`);
      }
      const now = this.clock.now();
      const added = await this.repo.insertWorkflowIfAbsent({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        status: 'published',
        draft_definition: definition,
        published_definition: definition,
        version: 1,
        published_at: now,
        created_at: now,
        updated_at: now,
      });
      if (added) inserted.push(definition.id);
    }
    return inserted;
  }
}

/** Minimal checks needed to store a draft safely; full catalog validation happens at publish. */
function assertDraftShape(input: unknown): WorkflowDefinition {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('invalid_definition', 'Request body must be a workflow definition object', 400);
  }
  const unsafe = findUnsafeKey(input);
  if (unsafe) {
    throw new DomainError('invalid_key', `Key '${unsafe}' is not allowed (keys must not start with '$' or contain '.')`, 400);
  }
  const def = input as Record<string, unknown>;
  if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) {
    throw new DomainError('invalid_definition', "Field 'id' is required and must match [A-Za-z0-9_-]{1,64}", 400);
  }
  if (typeof def.name !== 'string' || def.name.trim() === '') {
    throw new DomainError('invalid_definition', "Field 'name' is required and must be a non-empty string", 400);
  }
  return input as WorkflowDefinition;
}

function summarize(w: WorkflowRecord): WorkflowSummary {
  return {
    id: w.id,
    name: w.name,
    status: w.status,
    version: w.version,
    trigger_type: (w.published_definition ?? w.draft_definition)?.trigger?.type ?? null,
    has_unpublished_changes:
      w.published_definition !== null && JSON.stringify(w.published_definition) !== JSON.stringify(w.draft_definition),
    published_at: w.published_at ?? null,
    updated_at: w.updated_at,
  };
}
