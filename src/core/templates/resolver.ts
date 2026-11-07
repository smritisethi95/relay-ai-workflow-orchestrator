import { PermanentError } from '../domain/errors.js';

export interface TemplateContext {
  trigger: { body: unknown };
  nodes: Record<string, { output: unknown }>;
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE_TEMPLATE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const ROOTS = new Set(['trigger', 'nodes']);

/**
 * Resolves `{{trigger.body.x}}` and `{{nodes.<id>.output.y}}` in strings, arrays and objects.
 * Single pass: substituted values are never re-scanned, so data containing `{{...}}` stays data.
 * A whole-string template keeps the raw value type; embedded templates are stringified.
 */
export function resolveTemplates(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') return resolveString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, ctx));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplates(v, ctx);
    return out;
  }
  return value;
}

/** Lists every template path referenced inside a value (used by publish-time warnings). */
export function extractTemplatePaths(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(TEMPLATE)) paths.push(m[1]!.trim());
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (isPlainObject(v)) {
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
  return paths;
}

function resolveString(template: string, ctx: TemplateContext): unknown {
  const whole = WHOLE_TEMPLATE.exec(template);
  if (whole) return lookup(whole[1]!, ctx);
  return template.replace(TEMPLATE, (_match, path: string) => stringify(lookup(path, ctx)));
}

function lookup(rawPath: string, ctx: TemplateContext): unknown {
  const path = rawPath.trim();
  const segments = path.split('.');
  if (!ROOTS.has(segments[0]!) || segments.some((s) => !SEGMENT.test(s))) {
    throw new PermanentError('template_invalid', `Invalid template reference {{${path}}}`);
  }

  let current: unknown = ctx;
  for (const segment of segments) {
    // Own properties only, so paths like `constructor` or `__proto__` can never escape the data.
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      throw new PermanentError('template_unresolved', `Cannot resolve {{${path}}}: '${segment}' not found`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new PermanentError('template_unresolved', `Cannot resolve {{${path}}}: value is undefined`);
  }
  return current;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
