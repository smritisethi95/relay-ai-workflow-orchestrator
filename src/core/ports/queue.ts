export interface ClaimedJob {
  runId: string;
  claimCount: number;
}

/** Worker-side queue port: lease-based claiming of run jobs. Enqueueing is a Repository operation so it can join transactions. */
export interface Queue {
  /** Atomically leases the oldest ready job (available and not leased, or lease expired). */
  claim(workerId: string, leaseMs: number, now: Date): Promise<ClaimedJob | null>;
  /** Gives the job back (e.g. after an unexpected error) so it becomes available again at `availableAt`. */
  release(runId: string, workerId: string, availableAt: Date): Promise<void>;
}
