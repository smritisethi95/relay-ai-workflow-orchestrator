import type { NodeDef, RunRecord } from '../domain/types.js';
import type { AiAttempt } from '../domain/types.js';
import type { AIProvider } from '../ports/ai-provider.js';
import type { WorldClient } from '../ports/world-client.js';

export interface HandlerSettings {
  mockWorldUrl: string;
  allowedHttpHosts: readonly string[];
  httpTimeoutMs: number;
  aiTimeoutMs: number;
}

export interface NodeContext {
  run: RunRecord;
  node: NodeDef;
  /** Params after template resolution. */
  params: Record<string, unknown>;
  sequence: number;
  attempt: number;
  /** Present for side-effect nodes: `${run_id}:${node_id}:${sequence}`. */
  idempotencyKey?: string;
  /** When this step row was first created; stable across crash re-execution. */
  stepStartedAt: Date;
  now: Date;
  /** Engine-computed: an approved approval exists for this run. */
  approvalGranted: boolean;
  world: WorldClient;
  ai?: AIProvider;
  settings: HandlerSettings;
}

export type NodeResult =
  | {
      kind: 'completed';
      output: unknown;
      /** Overrides `node.next` (condition branches). */
      next?: string | null;
      tokens?: { prompt: number; completion: number };
      aiAttempts?: AiAttempt[];
    }
  | { kind: 'wait_delay'; resumeAt: Date }
  | { kind: 'wait_approval'; message: string };

/** Executes one node. Throw TransientError to retry with backoff, PermanentError to fail the run. */
export interface NodeHandler {
  execute(ctx: NodeContext): Promise<NodeResult>;
}
