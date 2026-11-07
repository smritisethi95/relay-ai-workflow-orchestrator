import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got '${raw}'`);
  }
  return value;
}

export type AiProviderKind = 'openai' | 'heuristic' | 'fake';

function aiProvider(): AiProviderKind {
  const value = str('AI_PROVIDER', 'openai');
  if (value !== 'openai' && value !== 'heuristic' && value !== 'fake') {
    throw new Error(`AI_PROVIDER must be openai | heuristic | fake, got '${value}'`);
  }
  return value;
}

export const config = Object.freeze({
  port: int('PORT', 8080),
  demoToken: str('RELAY_DEMO_TOKEN', 'relay-demo-token'),

  mongodbUri: str('MONGODB_URI', ''),
  mongodbDb: str('MONGODB_DB', 'relay'),
  dbTimeoutMs: int('DB_TIMEOUT_MS', 5000),

  mockWorldUrl: str('MOCK_WORLD_URL', 'http://localhost:9210'),
  allowedHttpHosts: str('ALLOWED_HTTP_HOSTS', 'localhost:9210')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  httpTimeoutMs: int('HTTP_TIMEOUT_MS', 5000),

  aiProvider: aiProvider(),
  aiBaseUrl: str('AI_BASE_URL', 'https://api.groq.com/openai/v1'),
  aiModel: str('AI_MODEL', 'openai/gpt-oss-120b'),
  aiApiKey: str('AI_API_KEY', ''),
  aiTimeoutMs: int('AI_TIMEOUT_MS', 20000),

  maxAttempts: int('MAX_ATTEMPTS', 4),
  backoffBaseMs: int('BACKOFF_BASE_MS', 1000),
  backoffMaxMs: int('BACKOFF_MAX_MS', 15000),
  leaseMs: int('LEASE_MS', 30000),
  pollMs: int('POLL_MS', 500),
  maxClaims: int('MAX_CLAIMS', 10),
  workerId: str('WORKER_ID', `worker-${process.pid}`),
});

export type Config = typeof config;
