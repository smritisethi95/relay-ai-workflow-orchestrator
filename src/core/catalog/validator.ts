import type { Catalog, CatalogParam } from './catalog.js';
import { compileSchema } from '../validation/json-schema.js';
import { findUnsafeKey } from '../guardrails/safe-keys.js';
import { extractTemplatePaths } from '../templates/resolver.js';

export interface ValidationIssue {
  code: string;
  message: string;
  node_id?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_STEPS_LIMIT = 1000;
const EDGE_KEYS = ['next', 'on_true', 'on_false'] as const;

type Obj = Record<string, unknown>;

/**
 * Validates a workflow definition against the node catalog. Collects every problem
 * (not first-fail). Loops are legal: run-time step caps bound them.
 */
export function validateDefinition(input: unknown, catalog: Catalog): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string, node_id?: string) => errors.push({ code, message, node_id });
  const warn = (code: string, message: string, node_id?: string) => warnings.push({ code, message, node_id });

  if (!isObj(input)) {
    err('invalid_definition', 'Definition must be a JSON object');
    return result(errors, warnings);
  }
  const def = input;

  const unsafeKey = findUnsafeKey(def);
  if (unsafeKey) err('invalid_key', `Key '${unsafeKey}' is not allowed (keys must not start with '$' or contain '.')`);

  if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) {
    err('invalid_definition', "Field 'id' is required and must match [A-Za-z0-9_-]{1,64}");
  }
  if (typeof def.name !== 'string' || def.name.trim() === '') {
    err('invalid_definition', "Field 'name' is required and must be a non-empty string");
  }
  if (def.description !== undefined && typeof def.description !== 'string') {
    err('invalid_definition', "Field 'description' must be a string");
  }

  validateTrigger(def.trigger, catalog, err);
  validateLimits(def.limits, err);

  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    err('invalid_definition', "Field 'nodes' is required and must be a non-empty array");
    if (typeof def.entry !== 'string') err('invalid_definition', "Field 'entry' is required");
    return result(errors, warnings);
  }

  const nodes: Obj[] = [];
  const ids = new Set<string>();
  def.nodes.forEach((raw, index) => {
    if (!isObj(raw)) {
      err('invalid_definition', `nodes[${index}] must be an object`);
      return;
    }
    if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
      err('invalid_definition', `nodes[${index}] has an invalid 'id' (must match [A-Za-z0-9_-]{1,64})`);
      return;
    }
    if (ids.has(raw.id)) {
      err('duplicate_node_id', `Node id '${raw.id}' appears more than once`, raw.id);
      return;
    }
    ids.add(raw.id);
    nodes.push(raw);
  });

  for (const node of nodes) validateNode(node, catalog, err, warn);

  if (typeof def.entry !== 'string' || def.entry === '') {
    err('invalid_definition', "Field 'entry' is required");
  } else if (!ids.has(def.entry)) {
    err('invalid_entry', `Entry '${def.entry}' does not match any node`);
  }

  for (const node of nodes) {
    for (const key of EDGE_KEYS) {
      const target = node[key];
      if (typeof target === 'string' && !ids.has(target)) {
        err('dangling_reference', `Node '${node.id}' ${key} → '${target}' does not exist`, node.id as string);
      }
    }
    for (const path of extractTemplatePaths(node.params)) {
      const [root, ref] = path.split('.');
      if (root === 'nodes' && ref && !ids.has(ref)) {
        warn('unknown_template_ref', `Node '${node.id}' references unknown node in {{${path}}}`, node.id as string);
      }
    }
  }

  if (errors.length === 0 && typeof def.entry === 'string') {
    graphWarnings(def.entry, nodes, catalog, warn);
  }
  return result(errors, warnings);
}

function validateTrigger(trigger: unknown, catalog: Catalog, err: (c: string, m: string) => void): void {
  if (!isObj(trigger) || typeof trigger.type !== 'string') {
    err('invalid_trigger', "Field 'trigger' is required and must have a 'type'");
    return;
  }
  const spec = catalog.trigger(trigger.type);
  if (!spec) {
    err('invalid_trigger', `Trigger type '${trigger.type}' is not in the catalog (allowed: ${catalog.triggerTypes().join(', ')})`);
    return;
  }
  for (const [name, param] of Object.entries(spec.config)) {
    const value = trigger[name];
    if (param.required && isMissing(value)) {
      err('invalid_trigger', `Trigger '${trigger.type}' requires '${name}'`);
    } else if (value !== undefined && !matchesType(value, param)) {
      err('invalid_trigger', `Trigger '${trigger.type}' field '${name}' must be a ${param.type}`);
    }
  }
}

function validateLimits(limits: unknown, err: (c: string, m: string) => void): void {
  if (!isObj(limits)) {
    err('invalid_limits', "Field 'limits' is required and must contain 'max_steps'");
    return;
  }
  const maxSteps = limits.max_steps;
  if (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) {
    err('invalid_limits', `limits.max_steps must be an integer between 1 and ${MAX_STEPS_LIMIT}`);
  }
  for (const key of ['timeout_seconds', 'max_ai_tokens']) {
    const value = limits[key];
    if (value !== undefined && (typeof value !== 'number' || value < 0)) {
      err('invalid_limits', `limits.${key} must be a non-negative number`);
    }
  }
}

function validateNode(
  node: Obj,
  catalog: Catalog,
  err: (c: string, m: string, n?: string) => void,
  warn: (c: string, m: string, n?: string) => void,
): void {
  const id = node.id as string;
  if (typeof node.type !== 'string') {
    err('invalid_node_type', `Node '${id}' is missing 'type'`, id);
    return;
  }
  const spec = catalog.node(node.type);
  if (!spec) {
    err('invalid_node_type', `Node '${id}' has unknown type '${node.type}'`, id);
    return;
  }

  const params = node.params === undefined ? {} : node.params;
  if (!isObj(params)) {
    err('invalid_definition', `Node '${id}' params must be an object`, id);
    return;
  }

  for (const [name, param] of Object.entries(spec.params)) {
    const value = params[name];
    if (isMissing(value)) {
      if (param.required) err('missing_param', `Node '${id}' (${node.type}) is missing required param '${name}'`, id);
      continue;
    }
    if (!matchesType(value, param)) {
      err('invalid_param', `Node '${id}' param '${name}' must be a ${param.type}`, id);
    } else if (param.enum && !param.enum.includes(value as string)) {
      err('invalid_param', `Node '${id}' param '${name}' must be one of: ${param.enum.join(', ')}`, id);
    }
  }
  for (const name of Object.keys(params)) {
    if (!(name in spec.params)) warn('unknown_param', `Node '${id}' (${node.type}) has unknown param '${name}'`, id);
  }

  if (node.type === 'ai' && isObj(params.output_schema)) {
    try {
      compileSchema(params.output_schema);
    } catch (e) {
      err('invalid_output_schema', `Node '${id}' output_schema is invalid: ${(e as Error).message}`, id);
    }
  }
  if (node.type === 'delay' && typeof params.seconds === 'number' && (params.seconds < 0 || params.seconds > 86_400)) {
    err('invalid_param', `Node '${id}' param 'seconds' must be between 0 and 86400`, id);
  }

  validateEdges(node, catalog.isBranching(node.type), err);
}

function validateEdges(node: Obj, branching: boolean, err: (c: string, m: string, n?: string) => void): void {
  const id = node.id as string;
  if (branching) {
    for (const key of ['on_true', 'on_false'] as const) {
      if (typeof node[key] !== 'string' || node[key] === '') {
        err('invalid_edges', `Condition node '${id}' requires '${key}'`, id);
      }
    }
    if (node.next !== undefined && node.next !== null) {
      err('invalid_edges', `Condition node '${id}' must use on_true/on_false, not 'next'`, id);
    }
    return;
  }
  if (node.on_true !== undefined || node.on_false !== undefined) {
    err('invalid_edges', `Node '${id}' is not a condition and cannot have on_true/on_false`, id);
  }
  if (node.next !== undefined && node.next !== null && typeof node.next !== 'string') {
    err('invalid_edges', `Node '${id}' next must be a node id or null`, id);
  }
}

/** Unreachable nodes, and sensitive nodes reachable without passing an approval node. */
function graphWarnings(entry: string, nodes: Obj[], catalog: Catalog, warn: (c: string, m: string, n?: string) => void): void {
  const byId = new Map(nodes.map((n) => [n.id as string, n]));
  const successors = (n: Obj): string[] =>
    EDGE_KEYS.map((k) => n[k]).filter((t): t is string => typeof t === 'string' && byId.has(t));

  const reachable = walk(entry, (id) => successors(byId.get(id)!));
  for (const id of byId.keys()) {
    if (!reachable.has(id)) warn('unreachable_node', `Node '${id}' is not reachable from entry`, id);
  }

  const reachableWithoutApproval = walk(entry, (id) => {
    const node = byId.get(id)!;
    return node.type === 'approval' ? [] : successors(node);
  });
  for (const id of reachableWithoutApproval) {
    const node = byId.get(id)!;
    if (catalog.requiresApproval(node.type as string)) {
      warn(
        'approval_not_guaranteed',
        `Node '${id}' (${node.type}) can be reached without an approval node; the engine will refuse to run it without an approved approval`,
        id,
      );
    }
  }
}

function walk(start: string, next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return seen;
}

function matchesType(value: unknown, param: CatalogParam): boolean {
  switch (param.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isObj(value);
    default:
      return true;
  }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function result(errors: ValidationIssue[], warnings: ValidationIssue[]): ValidationResult {
  return { ok: errors.length === 0, errors, warnings };
}
