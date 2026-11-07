const UNSAFE_KEY = /^\$|\./;

/**
 * Returns the JSON path of the first key that MongoDB could interpret as an operator
 * or a dotted path (`$where`, `a.b`), or null when the value is safe to store.
 */
export function findUnsafeKey(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findUnsafeKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (UNSAFE_KEY.test(key)) return childPath;
      const found = findUnsafeKey(child, childPath);
      if (found) return found;
    }
  }
  return null;
}
