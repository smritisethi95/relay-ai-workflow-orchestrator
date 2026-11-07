import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison that also hides length differences (both sides hashed first). */
export function secretsMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
