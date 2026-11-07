import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';

// ajv is CommonJS; under NodeNext the class lives on `.default`.
const Ajv = AjvModule.default;

const ajv = new Ajv({ strict: true, allErrors: true });
const cache = new Map<string, ValidateFunction>();

/** Compiles (and caches) a JSON Schema; throws if the schema itself is invalid. */
export function compileSchema(schema: unknown): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = cache.get(key);
  if (!validate) {
    validate = ajv.compile(schema as object);
    cache.set(key, validate);
  }
  return validate;
}

export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const where = e.instancePath || '(root)';
    const extra =
      e.keyword === 'enum'
        ? `: ${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)}`
        : e.keyword === 'additionalProperties'
          ? `: '${(e.params as { additionalProperty?: string }).additionalProperty}'`
          : '';
    return `${where} ${e.message ?? 'is invalid'}${extra}`;
  });
}
