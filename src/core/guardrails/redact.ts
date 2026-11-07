export const REDACTED = '[redacted]';

// Exact key names only: a looser match like /token/ would also hide `max_ai_tokens`.
const SECRET_KEY = /^(secret|password|passwd|api[_-]?key|authorization|x-relay-secret|access[_-]?token|client[_-]?secret)$/i;

/** Deep-copies a value, replacing secret-looking fields (webhook secrets, API keys, auth headers). */
export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) && child !== undefined && child !== null ? REDACTED : redact(child);
    }
    return out;
  }
  return value;
}
