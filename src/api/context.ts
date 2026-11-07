import type { Catalog } from '../core/catalog/catalog.js';
import { ApprovalService } from '../core/services/approval.service.js';
import { RunService } from '../core/services/run.service.js';
import { TriggerService } from '../core/services/trigger.service.js';
import { WorkflowService } from '../core/services/workflow.service.js';
import type { Repository } from '../core/ports/repository.js';
import { loadCatalog, loadSeedWorkflows } from '../infra/data/pack-data.js';
import { connectMongo } from '../infra/db/mongo.js';
import { ensureIndexes } from '../infra/db/indexes.js';
import { MongoRepository } from '../infra/repositories/mongo-repository.js';

/** Everything the HTTP layer needs, built once at boot (composition root). */
export interface AppContext {
  catalog: Catalog;
  repo: Repository;
  workflows: WorkflowService;
  triggers: TriggerService;
  runs: RunService;
  approvals: ApprovalService;
}

export async function createAppContext(): Promise<AppContext> {
  const db = await connectMongo();
  await ensureIndexes(db);
  const catalog = loadCatalog();
  const repo = new MongoRepository(db);
  const workflows = new WorkflowService(repo, catalog);

  const seeded = await workflows.seed(loadSeedWorkflows());
  console.log(seeded.length ? `Seeded workflows: ${seeded.join(', ')}` : 'Seed workflows already present');

  return {
    catalog,
    repo,
    workflows,
    triggers: new TriggerService(repo),
    runs: new RunService(repo),
    approvals: new ApprovalService(repo),
  };
}
