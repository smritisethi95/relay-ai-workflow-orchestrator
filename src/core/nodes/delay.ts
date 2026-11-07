import { PermanentError } from '../domain/errors.js';
import type { NodeHandler } from './types.js';

/** Durable delay: the resume time is anchored to the step's creation, so a crash never restarts the wait. */
export const delayHandler: NodeHandler = {
  async execute({ node, params, stepStartedAt, now }) {
    const seconds = params.seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      throw new PermanentError('invalid_param', `Delay '${node.id}' needs a non-negative 'seconds'`);
    }
    const resumeAt = new Date(stepStartedAt.getTime() + seconds * 1000);
    if (now >= resumeAt) {
      return { kind: 'completed', output: { waited_seconds: seconds, resumed_at: now.toISOString() } };
    }
    return { kind: 'wait_delay', resumeAt };
  },
};
