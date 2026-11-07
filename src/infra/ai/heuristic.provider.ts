import { SCHEMA_MARKER } from '../../core/nodes/ai.js';
import type { AIProvider, AiCompletion, AiCompletionRequest } from '../../core/ports/ai-provider.js';

interface SchemaProperty {
  type?: string;
  enum?: string[];
  maxLength?: number;
}

const CATEGORY_RULES: [string, RegExp][] = [
  ['refund_request', /\b(refund|money back|reimburse|chargeback|return (it|this|the))\b/i],
  ['complaint', /\b(broken|broke|cracked|damaged|defective|disappointed|stopped working|terrible|wrong item|never arrived|late)\b/i],
];
const HIGH_PRIORITY = /\b(urgent|asap|immediately|unacceptable|furious|money back|stopped working)\b/i;

/**
 * Offline, deterministic fallback (AI_PROVIDER=heuristic): keyword rules filled into whatever the output
 * schema asks for. It never echoes customer text, so injected instructions cannot leak into the output.
 */
export class HeuristicProvider implements AIProvider {
  async complete(req: AiCompletionRequest): Promise<AiCompletion> {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const schema = parseSchema(system);
    const text = untrustedSection(user);

    const category = CATEGORY_RULES.find(([, re]) => re.test(text))?.[0] ?? 'question';
    const priority = category === 'question' ? 'low' : HIGH_PRIORITY.test(text) ? 'high' : 'medium';
    const matched = [...CATEGORY_RULES.map(([, re]) => re), HIGH_PRIORITY].flatMap((re) => text.match(re)?.[0] ?? []);
    const summary = `Classified as ${category.replace('_', ' ')} by keyword rules (${matched.length ? matched.join(', ') : 'no keywords matched'}).`;

    const out: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      if (prop.enum) {
        const preferred = name === 'category' ? category : name === 'priority' ? priority : undefined;
        out[name] = preferred && prop.enum.includes(preferred) ? preferred : prop.enum[0];
      } else if (prop.type === 'string') {
        out[name] = prop.maxLength ? summary.slice(0, prop.maxLength) : summary;
      } else if (prop.type === 'number' || prop.type === 'integer') {
        out[name] = 0;
      } else if (prop.type === 'boolean') {
        out[name] = false;
      }
    }

    const reply = JSON.stringify(out);
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    return { text: reply, usage: { prompt: req.messages.reduce((n, m) => n + words(m.content), 0), completion: words(reply) } };
  }
}

function parseSchema(system: string): { properties?: Record<string, SchemaProperty> } {
  const index = system.indexOf(SCHEMA_MARKER);
  if (index < 0) return {};
  try {
    return JSON.parse(system.slice(index + SCHEMA_MARKER.length).trim());
  } catch {
    return {};
  }
}

function untrustedSection(prompt: string): string {
  const match = /---\s*([\s\S]*?)\s*---/.exec(prompt);
  return match ? match[1]! : prompt;
}
