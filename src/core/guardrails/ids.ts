import { DomainError } from '../domain/errors.js';

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Path ids are only ever plain strings; anything else is treated as not found. */
export function assertValidId(id: unknown, kind: string): asserts id is string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new DomainError('not_found', `${kind} '${String(id)}' not found`, 404);
  }
}
