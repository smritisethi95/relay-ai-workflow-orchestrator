import { describe, expect, it } from 'vitest';
import { backoffMs, errorForStatus, isRetryableStatus } from '../../src/core/engine/retry.js';
import { assertUrlAllowed } from '../../src/core/guardrails/url-allowlist.js';

describe('retry classification', () => {
  it.each([
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
    [409, false],
  ])('status %i retryable=%s', (status, retryable) => {
    expect(isRetryableStatus(status)).toBe(retryable);
    expect(errorForStatus(status, { error: { message: 'nope' } }, 'call').retryable).toBe(retryable);
  });

  it('includes the remote error message', () => {
    expect(errorForStatus(400, { error: { message: 'Refund of $5000 exceeds order total' } }, 'order refund').message).toBe(
      'order refund returned HTTP 400: Refund of $5000 exceeds order total',
    );
  });
});

describe('backoffMs', () => {
  it('grows exponentially and caps', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffMs(a, 1000, 15000, mid))).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it('applies ±20 % jitter', () => {
    expect(backoffMs(1, 1000, 15000, () => 0)).toBe(800);
    expect(backoffMs(1, 1000, 15000, () => 1)).toBe(1200);
  });
});

describe('assertUrlAllowed', () => {
  const allowed = ['localhost:9210'];
  it('allows the mock world', () => {
    expect(assertUrlAllowed('http://localhost:9210/orders/ord_2001', allowed).pathname).toBe('/orders/ord_2001');
  });
  it.each(['http://169.254.169.254/latest', 'http://localhost:22/', 'file:///etc/passwd', 'http://user:pw@localhost:9210/', 'not a url'])(
    'blocks %s',
    (url) => {
      expect(() => assertUrlAllowed(url, allowed)).toThrow();
    },
  );
});
