import { WorkflowService } from '../core/services/workflow.service.js';
import { loadCatalog, loadSeedWorkflows } from '../infra/data/pack-data.js';
import { closeMongo, connectMongo } from '../infra/db/mongo.js';
import { ensureIndexes } from '../infra/db/indexes.js';
import { MongoRepository } from '../infra/repositories/mongo-repository.js';

try {
  const db = await connectMongo();
  await ensureIndexes(db);
  const service = new WorkflowService(new MongoRepository(db), loadCatalog());
  const inserted = await service.seed(loadSeedWorkflows());
  console.log(inserted.length ? `Seeded: ${inserted.join(', ')}` : 'All seed workflows already present');
} catch (err) {
  console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeMongo();
}
