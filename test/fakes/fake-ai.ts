import type { AIProvider, AiCompletion, AiCompletionRequest, ChatMessage } from '../../src/core/ports/ai-provider.js';

type Reply = string | Error | ((messages: ChatMessage[]) => string);

/** Scripted model for engine tests: returns queued replies in order and records every request. */
export class ScriptedAI implements AIProvider {
  readonly requests: AiCompletionRequest[] = [];
  private readonly replies: Reply[];

  constructor(...replies: Reply[]) {
    this.replies = replies;
  }

  push(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletion> {
    this.requests.push(structuredClone(req));
    const next = this.replies.shift();
    if (next === undefined) throw new Error('ScriptedAI: no reply queued');
    if (next instanceof Error) throw next;
    const text = typeof next === 'function' ? next(req.messages) : next;
    return { text, usage: { prompt: 100, completion: 20 } };
  }
}
