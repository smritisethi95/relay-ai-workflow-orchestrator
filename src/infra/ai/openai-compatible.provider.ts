import { PermanentError, TransientError } from '../../core/domain/errors.js';
import type { AIProvider, AiCompletion, AiCompletionRequest } from '../../core/ports/ai-provider.js';

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string; failed_generation?: string };
}

/** OpenAI-compatible chat completions (Groq by default). The API key is only ever sent in the Authorization header. */
export class OpenAICompatibleProvider implements AIProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    if (!apiKey) throw new Error('AI_API_KEY is not set (required for AI_PROVIDER=openai)');
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletion> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages,
      temperature: 0,
      max_completion_tokens: 2048,
    };
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (this.model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new TransientError('ai_timeout', `Model call timed out after ${req.timeoutMs} ms`);
      }
      throw new TransientError('ai_network_error', `Model call failed: ${(err as Error).message}`);
    }

    const data = (await res.json().catch(() => ({}))) as ChatCompletionResponse;
    const usage = { prompt: data.usage?.prompt_tokens ?? 0, completion: data.usage?.completion_tokens ?? 0 };

    // Groq rejects JSON-mode output that isn't valid JSON with a 400; that is a bad model answer, not a bad request,
    // so it is handed back as text and goes through schema validation + the repair retry like any invalid reply.
    if (res.status === 400 && data.error?.code === 'json_validate_failed') {
      return { text: data.error.failed_generation ?? '', usage };
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new TransientError('ai_provider_error', `Model provider returned HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new PermanentError('ai_provider_error', `Model provider returned HTTP ${res.status}: ${data.error?.message ?? 'request rejected'}`, res.status);
    }
    return { text: data.choices?.[0]?.message?.content ?? '', usage };
  }
}
