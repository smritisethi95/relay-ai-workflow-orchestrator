import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Catalog, type NodeCatalogData } from '../../core/catalog/catalog.js';
import type { WorkflowDefinition } from '../../core/domain/types.js';

const DATA_DIR = resolve(process.cwd(), 'data');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf8')) as T;
}

export function loadCatalog(): Catalog {
  return new Catalog(readJson<NodeCatalogData>('node_catalog.json'));
}

export function loadSeedWorkflows(): WorkflowDefinition[] {
  return readJson<{ workflows: WorkflowDefinition[] }>('seed_workflows.json').workflows;
}

export interface SamplePayload {
  id: string;
  workflow: string;
  note: string;
  body: Record<string, unknown>;
}

export function loadSamplePayloads(): SamplePayload[] {
  return readFileSync(resolve(DATA_DIR, 'sample_payloads.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SamplePayload);
}
