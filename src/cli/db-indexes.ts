import { closeMongo, connectMongo } from '../infra/db/mongo.js';
import { ensureIndexes } from '../infra/db/indexes.js';

try {
  const db = await connectMongo();
  const created = await ensureIndexes(db);
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  console.log(`Connected to database '${db.databaseName}'.`);
  console.log(`Created collections: ${created.length ? created.join(', ') : '(none, already present)'}`);
  for (const name of collections) {
    const indexes = await db.collection(name).indexes();
    console.log(`  ${name}: ${indexes.map((i) => i.name).join(', ')}`);
  }
} catch (err) {
  console.error(`db:indexes failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeMongo();
}
