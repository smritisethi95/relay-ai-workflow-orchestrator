import { WorkflowService } from '../core/services/workflow.service.js';
import { loadCatalog, loadSeedWorkflows } from '../infra/data/pack-data.js';
import { closeMongo, COLLECTIONS, connectMongo } from '../infra/db/mongo.js';
import { ensureIndexes } from '../infra/db/indexes.js';
import { MongoRepository } from '../infra/repositories/mongo-repository.js';

// Wipes every run, step, approval, job and workflow, then re-seeds the four pack workflows. Demo prep only.
if (!process.argv.includes('--yes')) {
  console.error('Refusing to wipe the database without --yes (npm run db:reset-demo passes it).');
  process.exit(1);
}

try {
  const db = await connectMongo();
  await ensureIndexes(db);
  for (const name of [COLLECTIONS.jobs, COLLECTIONS.approvals, COLLECTIONS.steps, COLLECTIONS.runs, COLLECTIONS.workflows]) {
    const { deletedCount } = await db.collection(name).deleteMany({});
    console.log(`  ${name.padEnd(10)} deleted ${deletedCount}`);
  }
  const seeded = await new WorkflowService(new MongoRepository(db), loadCatalog()).seed(loadSeedWorkflows());
  console.log(`Re-seeded: ${seeded.join(', ')}`);
} catch (err) {
  console.error(`db:reset-demo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeMongo();
}
