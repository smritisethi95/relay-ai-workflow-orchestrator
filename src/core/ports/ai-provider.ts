export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  messages: ChatMessage[];
  jsonMode: boolean;
  timeoutMs: number;
}

export interface AiCompletion {
  text: string;
  usage: { prompt: number; completion: number };
}

/** Model-provider port. Provider timeouts / 429 / 5xx must be thrown as TransientError. */
export interface AIProvider {
  complete(req: AiCompletionRequest): Promise<AiCompletion>;
}
