import type { Collection, Db } from 'mongodb';
import type { ClaimedJob, Queue } from '../../core/ports/queue.js';
import { COLLECTIONS } from '../db/mongo.js';
import type { JobDoc } from '../repositories/mongo-repository.js';

/** Lease-based queue over the `jobs` collection; findOneAndUpdate is the Mongo equivalent of FOR UPDATE SKIP LOCKED. */
export class MongoQueue implements Queue {
  private readonly jobs: Collection<JobDoc>;

  constructor(db: Db) {
    this.jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  }

  async claim(workerId: string, leaseMs: number, now: Date): Promise<ClaimedJob | null> {
    const job = await this.jobs.findOneAndUpdate(
      {
        available_at: { $lte: now },
        $or: [{ locked_until: null }, { locked_until: { $lt: now } }],
      },
      {
        $set: { locked_by: workerId, locked_until: new Date(now.getTime() + leaseMs) },
        $inc: { claim_count: 1 },
      },
      { sort: { available_at: 1 }, returnDocument: 'after' },
    );
    return job ? { runId: job._id, claimCount: job.claim_count } : null;
  }

  async release(runId: string, workerId: string, availableAt: Date): Promise<void> {
    await this.jobs.updateOne(
      { _id: runId, locked_by: workerId },
      { $set: { available_at: availableAt, locked_by: null, locked_until: null } },
    );
  }
}
