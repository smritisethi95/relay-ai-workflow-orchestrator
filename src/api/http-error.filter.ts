import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { toErrorResponse } from './error-response.js';

interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = toErrorResponse(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    host.switchToHttp().getResponse<JsonResponse>().status(status).json(body);
  }
}
