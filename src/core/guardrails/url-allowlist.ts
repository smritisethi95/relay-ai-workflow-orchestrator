import { PermanentError } from '../domain/errors.js';

/**
 * SSRF guard for templated URLs: only http(s) to an allow-listed host:port.
 * Entries in `allowed` are lower-case `host:port` (e.g. `localhost:9210`).
 */
export function assertUrlAllowed(rawUrl: string, allowed: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PermanentError('invalid_url', `'${rawUrl}' is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PermanentError('url_not_allowed', `Protocol '${url.protocol}' is not allowed`);
  }
  if (url.username || url.password) {
    throw new PermanentError('url_not_allowed', 'URLs with embedded credentials are not allowed');
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hostPort = `${url.hostname.toLowerCase()}:${port}`;
  if (!allowed.includes(hostPort)) {
    throw new PermanentError('url_not_allowed', `Host '${hostPort}' is not in ALLOWED_HTTP_HOSTS`);
  }
  return url;
}
