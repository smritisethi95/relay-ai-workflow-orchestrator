import { writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { Engine } from '../core/engine/engine.js';
import { backoffMs } from '../core/engine/retry.js';
import { defaultHandlers } from '../core/nodes/index.js';
import { systemClock } from '../core/ports/clock.js';
import { loadCatalog } from '../infra/data/pack-data.js';
import { createAiProvider } from '../infra/ai/create-provider.js';
import { closeMongo, connectMongo } from '../infra/db/mongo.js';
import { ensureIndexes } from '../infra/db/indexes.js';
import { MongoQueue } from '../infra/queue/mongo-queue.js';
import { MongoRepository } from '../infra/repositories/mongo-repository.js';
import { CrashAfterCallWorldClient } from '../infra/world/crash-after-call.js';
import { HttpWorldClient } from '../infra/world/http-world-client.js';

const PID_FILE = '.worker.pid';
let stopping = false;

function log(message: string): void {
  console.log(`${new Date().toISOString()} [worker ${config.workerId}] ${message}`);
}

async function main(): Promise<void> {
  const db = await connectMongo();
  await ensureIndexes(db);
  const repo = new MongoRepository(db);
  const queue = new MongoQueue(db);
  const crashAfter = process.env.RELAY_CRASH_AFTER_CALL;
  const world = crashAfter ? new CrashAfterCallWorldClient(new HttpWorldClient(), crashAfter) : new HttpWorldClient();
  if (crashAfter) log(`CRASH DRILL ARMED: will exit right after the first successful call by node '${crashAfter}'`);
  const ai = createAiProvider(config);
  const engine = new Engine({
    repo,
    catalog: loadCatalog(),
    handlers: defaultHandlers(),
    world,
    ai: ai.provider,
    clock: systemClock,
    settings: {
      mockWorldUrl: config.mockWorldUrl.replace(/\/+$/, ''),
      allowedHttpHosts: config.allowedHttpHosts,
      httpTimeoutMs: config.httpTimeoutMs,
      aiTimeoutMs: config.aiTimeoutMs,
      maxAttempts: config.maxAttempts,
      backoffBaseMs: config.backoffBaseMs,
      backoffMaxMs: config.backoffMaxMs,
      maxClaims: config.maxClaims,
      leaseMs: config.leaseMs,
    },
  });

  writeFileSync(PID_FILE, String(process.pid));
  log(`started (pid ${process.pid}, lease ${config.leaseMs} ms, poll ${config.pollMs} ms, ai ${ai.description})`);

  while (!stopping) {
    let job;
    try {
      job = await queue.claim(config.workerId, config.leaseMs, new Date());
    } catch (err) {
      log(`claim failed: ${(err as Error).message}`);
      await sleep(config.pollMs * 4);
      continue;
    }
    if (!job) {
      await sleep(config.pollMs);
      continue;
    }
    try {
      const outcome = await engine.advance(job.runId, config.workerId, job.claimCount);
      log(`${job.runId} claim#${job.claimCount} → ${outcome}`);
    } catch (err) {
      // Unexpected (e.g. database) error: give the job back with backoff; the run resumes from persisted steps.
      log(`${job.runId} advance failed: ${(err as Error).message}`);
      const retryAt = new Date(Date.now() + backoffMs(job.claimCount, config.backoffBaseMs, config.backoffMaxMs));
      await queue.release(job.runId, config.workerId, retryAt).catch(() => undefined);
    }
  }
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, finishing current claim`);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main()
  .catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    rmSync(PID_FILE, { force: true });
    await closeMongo();
    log('stopped');
  });
