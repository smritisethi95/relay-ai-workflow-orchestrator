import { Engine, type EngineSettings } from '../../src/core/engine/engine.js';
import { defaultHandlers, type HandlerRegistry } from '../../src/core/nodes/index.js';
import type { AIProvider } from '../../src/core/ports/ai-provider.js';
import { ApprovalService } from '../../src/core/services/approval.service.js';
import { RunService } from '../../src/core/services/run.service.js';
import { TriggerService } from '../../src/core/services/trigger.service.js';
import { WorkflowService } from '../../src/core/services/workflow.service.js';
import { loadCatalog, loadSeedWorkflows } from '../../src/infra/data/pack-data.js';
import { FakeWorld } from './fake-world.js';
import { InMemoryRepository } from './in-memory-repository.js';

export class FakeClock {
  private t = Date.UTC(2026, 10, 7, 12, 0, 0);
  now = (): Date => new Date(this.t);
  set(date: Date): void {
    this.t = Math.max(this.t, date.getTime());
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const LEASE_MS = 30_000;

export const testSettings: EngineSettings = {
  mockWorldUrl: 'http://localhost:9210',
  allowedHttpHosts: ['localhost:9210'],
  httpTimeoutMs: 5000,
  aiTimeoutMs: 20000,
  maxAttempts: 4,
  backoffBaseMs: 1000,
  backoffMaxMs: 15000,
  maxClaims: 10,
  leaseMs: LEASE_MS,
  random: () => 0.5,
};

/** Wires the real engine and services to in-memory fakes, with a deterministic clock. */
export async function createHarness(options: { handlers?: HandlerRegistry; ai?: AIProvider } = {}) {
  const repo = new InMemoryRepository();
  const clock = new FakeClock();
  const world = new FakeWorld();
  const catalog = loadCatalog();
  const workflows = new WorkflowService(repo, catalog, clock);
  await workflows.seed(loadSeedWorkflows());
  const triggers = new TriggerService(repo, clock);
  const approvals = new ApprovalService(repo, clock);
  const runs = new RunService(repo, clock);
  const engine = new Engine({
    repo,
    catalog,
    handlers: defaultHandlers(options.handlers),
    world,
    ai: options.ai,
    clock,
    settings: testSettings,
  });

  /** Plays the worker: claims and advances until no job is left, jumping the clock over delays/backoff/leases. */
  async function drain(workerId = 'w1', maxClaims = 500): Promise<void> {
    for (let i = 0; i < maxClaims; i++) {
      const job = await repo.claim(workerId, LEASE_MS, clock.now());
      if (!job) {
        const next = repo.nextJobAt();
        if (!next) return;
        clock.set(new Date(Math.max(next.getTime(), clock.now().getTime()) + 1));
        continue;
      }
      await engine.advance(job.runId, workerId, job.claimCount);
    }
    throw new Error('drain did not settle');
  }

  async function publish(definition: Record<string, unknown>): Promise<void> {
    await workflows.create(definition);
    await workflows.publish(definition.id as string);
  }

  return { repo, clock, world, catalog, workflows, triggers, approvals, runs, engine, drain, publish };
}
