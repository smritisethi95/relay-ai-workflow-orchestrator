import type { NodeHandler } from './types.js';

/** Pauses the run; only the approve API can complete this step. */
export const approvalHandler: NodeHandler = {
  async execute({ params }) {
    const message = typeof params.message === 'string' ? params.message : JSON.stringify(params.message);
    return { kind: 'wait_approval', message };
  },
};
