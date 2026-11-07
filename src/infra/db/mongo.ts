import { MongoClient, type ClientSession, type Db, type TransactionOptions } from 'mongodb';
import { config } from '../../config.js';

export const COLLECTIONS = {
  workflows: 'workflows',
  runs: 'runs',
  steps: 'steps',
  approvals: 'approvals',
  jobs: 'jobs',
} as const;

const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

let client: MongoClient | undefined;

export async function connectMongo(): Promise<Db> {
  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and add your Atlas connection string.');
  }
  if (!client) {
    client = new MongoClient(config.mongodbUri, {
      serverSelectionTimeoutMS: config.dbTimeoutMs,
      connectTimeoutMS: config.dbTimeoutMs,
      retryWrites: true,
      writeConcern: { w: 'majority' },
      appName: 'relay',
    });
    await client.connect();
  }
  return client.db(config.mongodbDb);
}

export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  if (!client) throw new Error('MongoDB is not connected; call connectMongo() first.');
  const session = client.startSession();
  try {
    return await session.withTransaction(() => fn(session), TRANSACTION_OPTIONS);
  } finally {
    await session.endSession();
  }
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
