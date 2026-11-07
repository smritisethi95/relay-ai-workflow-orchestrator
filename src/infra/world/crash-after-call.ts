import type { WorldClient, WorldRequest, WorldResponse } from '../../core/ports/world-client.js';

/**
 * Drill-only decorator (enabled by RELAY_CRASH_AFTER_CALL=<node_id>): hard-exits the process right after
 * that node's external call succeeds and before the engine can persist the result — the exact crash
 * window that idempotency keys exist for. Fires once per process.
 */
export class CrashAfterCallWorldClient implements WorldClient {
  private fired = false;

  constructor(
    private readonly inner: WorldClient,
    private readonly nodeId: string,
  ) {}

  async request(req: WorldRequest): Promise<WorldResponse> {
    const res = await this.inner.request(req);
    if (!this.fired && req.idempotencyKey?.split(':')[1] === this.nodeId && res.status >= 200 && res.status < 300) {
      this.fired = true;
      console.error(`${new Date().toISOString()} [crash-drill] ${req.idempotencyKey} reached the world (HTTP ${res.status}); exiting before persisting`);
      process.exit(137);
    }
    return res;
  }
}
