import type { Config } from '../../config.js';
import type { AIProvider } from '../../core/ports/ai-provider.js';
import { HeuristicProvider } from './heuristic.provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';

export function createAiProvider(config: Config): { provider: AIProvider; description: string } {
  if (config.aiProvider === 'heuristic') {
    return { provider: new HeuristicProvider(), description: 'heuristic (offline keyword rules)' };
  }
  return {
    provider: new OpenAICompatibleProvider(config.aiBaseUrl, config.aiApiKey, config.aiModel),
    description: `${config.aiModel} via ${new URL(config.aiBaseUrl).host}`,
  };
}
