import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Controller, Get, Header, Inject, Redirect } from '@nestjs/common';
import { Catalog } from '../../core/catalog/catalog.js';
import { loadSamplePayloads } from '../../infra/data/pack-data.js';
import { Public } from '../auth.js';

const CONSOLE_FILE = resolve(process.cwd(), 'src/api/console/index.html');
// Inline script/style only; all API calls are same-origin; the page can't be framed.
const CONSOLE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

@Controller()
export class SystemController {
  constructor(@Inject(Catalog) private readonly catalog: Catalog) {}

  @Public()
  @Get()
  @Redirect('/console', 302)
  root() {}

  @Public()
  @Get('console')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', CONSOLE_CSP)
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Cache-Control', 'no-store')
  console() {
    return readFile(CONSOLE_FILE, 'utf8');
  }

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', service: 'relay-api' };
  }

  @Get('catalog')
  getCatalog() {
    return {
      triggers: this.catalog.triggerTypes().map((t) => this.catalog.trigger(t)),
      nodes: this.catalog.nodeTypes().map((t) => this.catalog.node(t)),
    };
  }

  /** The pack's sample trigger bodies, used by the console's trigger form. */
  @Get('samples')
  samples() {
    return loadSamplePayloads().map(({ id, workflow, note, body }) => ({ id, workflow, note, body }));
  }
}
