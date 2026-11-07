import type { Db, IndexDescription } from 'mongodb';
import { COLLECTIONS } from './mongo.js';

const INDEXES: Record<string, IndexDescription[]> = {
  [COLLECTIONS.workflows]: [],
  [COLLECTIONS.runs]: [
    { key: { workflow_id: 1, created_at: -1 }, name: 'runs_workflow' },
    { key: { status: 1, created_at: -1 }, name: 'runs_status' },
  ],
  [COLLECTIONS.steps]: [{ key: { run_id: 1, sequence: 1 }, name: 'steps_run_sequence', unique: true }],
  [COLLECTIONS.approvals]: [
    { key: { run_id: 1, node_id: 1, step_sequence: 1 }, name: 'approvals_run_node_seq', unique: true },
    { key: { run_id: 1, status: 1 }, name: 'approvals_run_status' },
    { key: { status: 1, created_at: 1 }, name: 'approvals_status' },
  ],
  [COLLECTIONS.jobs]: [{ key: { available_at: 1, locked_until: 1 }, name: 'jobs_ready' }],
};

// Collections are created up front because implicit creation inside transactions is best avoided.
export async function ensureIndexes(db: Db): Promise<string[]> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const created: string[] = [];

  for (const [name, indexes] of Object.entries(INDEXES)) {
    if (!existing.has(name)) {
      await db.createCollection(name);
      created.push(name);
    }
    if (indexes.length > 0) {
      await db.collection(name).createIndexes(indexes);
    }
  }
  return created;
}
