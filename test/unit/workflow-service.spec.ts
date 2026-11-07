import { beforeEach, describe, expect, it } from 'vitest';
import { WorkflowService } from '../../src/core/services/workflow.service.js';
import { DomainError } from '../../src/core/domain/errors.js';
import { loadCatalog, loadSeedWorkflows } from '../../src/infra/data/pack-data.js';
import { InMemoryRepository } from '../fakes/in-memory-repository.js';

const catalog = loadCatalog();

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 7, 12, 0, tick++)) };

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf_demo',
    name: 'Demo',
    trigger: { type: 'manual' },
    entry: 'hello',
    limits: { max_steps: 5 },
    nodes: [{ id: 'hello', type: 'notify', params: { channel: 'chat', to: '#demo', message: 'hi' }, next: null }],
    ...overrides,
  };
}

async function expectDomainError(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toBeInstanceOf(DomainError);
  await promise.catch((e: DomainError) => {
    expect(e.code).toBe(code);
    expect(e.httpStatus).toBe(status);
  });
}

describe('WorkflowService', () => {
  let repo: InMemoryRepository;
  let service: WorkflowService;

  beforeEach(() => {
    repo = new InMemoryRepository();
    service = new WorkflowService(repo, catalog, clock);
  });

  it('seeds the four pack workflows as published v1, idempotently', async () => {
    expect(await service.seed(loadSeedWorkflows())).toEqual(['wf_support_triage', 'wf_expense_approval', 'wf_slow_fulfillment', 'wf_runaway']);
    expect(await service.seed(loadSeedWorkflows())).toEqual([]);
    const list = await service.list();
    expect(list.map((w) => [w.id, w.status, w.version])).toEqual([
      ['wf_expense_approval', 'published', 1],
      ['wf_runaway', 'published', 1],
      ['wf_slow_fulfillment', 'published', 1],
      ['wf_support_triage', 'published', 1],
    ]);
    expect(list.every((w) => !w.has_unpublished_changes)).toBe(true);
  });

  it('creates a draft and reports validation issues without rejecting the draft', async () => {
    const { workflow, validation } = await service.create(definition({ nodes: [{ id: 'hello', type: 'teleport', params: {}, next: null }] }));
    expect(workflow.status).toBe('draft');
    expect(workflow.published_definition).toBeNull();
    expect(validation.errors.map((e) => e.code)).toEqual(['invalid_node_type']);
  });

  it('rejects duplicate ids with 409', async () => {
    await service.create(definition());
    await expectDomainError(service.create(definition()), 'workflow_exists', 409);
  });

  it('rejects bodies that are not storable drafts', async () => {
    await expectDomainError(service.create([]), 'invalid_definition', 400);
    await expectDomainError(service.create(definition({ id: 'bad id!' })), 'invalid_definition', 400);
    await expectDomainError(service.create(definition({ $where: 'x' })), 'invalid_key', 400);
  });

  it('refuses to publish an invalid draft with 422 and every error in details', async () => {
    await service.create(definition({ nodes: [{ id: 'hello', type: 'notify', params: { channel: 'chat' }, next: 'ghost' }] }));
    const err = await service.publish('wf_demo').catch((e: DomainError) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).httpStatus).toBe(422);
    expect((err as DomainError).code).toBe('validation_failed');
    expect(((err as DomainError).details as { code: string }[]).map((d) => d.code)).toEqual([
      'missing_param',
      'missing_param',
      'dangling_reference',
    ]);
  });

  it('publishes a frozen copy; later edits only touch the draft until republished', async () => {
    await service.create(definition());
    const v1 = await service.publish('wf_demo');
    expect(v1.workflow.version).toBe(1);

    await service.updateDraft('wf_demo', definition({ name: 'Demo v2' }));
    let stored = await service.get('wf_demo');
    expect(stored.status).toBe('published');
    expect(stored.published_definition?.name).toBe('Demo');
    expect(stored.draft_definition.name).toBe('Demo v2');
    expect((await service.list())[0]!.has_unpublished_changes).toBe(true);

    const v2 = await service.publish('wf_demo');
    expect(v2.workflow.version).toBe(2);
    stored = await service.get('wf_demo');
    expect(stored.published_definition?.name).toBe('Demo v2');
  });

  it('rejects an update whose body id differs from the path id', async () => {
    await service.create(definition());
    await expectDomainError(service.updateDraft('wf_demo', definition({ id: 'wf_other' })), 'invalid_definition', 400);
  });

  it('returns 404 for unknown or malformed ids', async () => {
    await expectDomainError(service.get('wf_missing'), 'not_found', 404);
    await expectDomainError(service.get('$where'), 'not_found', 404);
    await expectDomainError(service.publish('wf_missing'), 'not_found', 404);
  });
});
