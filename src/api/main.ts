import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { config } from '../config.js';
import { AppModule } from './app.module.js';
import { createAppContext } from './context.js';
import { toErrorResponse } from './error-response.js';

const BODY_LIMIT = '256kb';

async function bootstrap(): Promise<void> {
  const ctx = await createAppContext();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(ctx), { bodyParser: false });

  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: BODY_LIMIT });
  // body-parser failures happen before Nest's filters; answer them with the same error shape.
  app.use((err: unknown, _req: unknown, res: { status(c: number): { json(b: unknown): void } }, next: (e?: unknown) => void) => {
    if (!err) return next();
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  });
  app.enableShutdownHooks();

  await app.listen(config.port);
  new Logger('Relay').log(`API listening on http://localhost:${config.port}`);
}

bootstrap().catch((err: unknown) => {
  console.error(`API failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
