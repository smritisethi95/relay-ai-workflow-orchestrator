import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { TriggerService } from '../../core/services/trigger.service.js';
import { Public } from '../auth.js';

/** External callers authenticate with the per-workflow secret only (no platform token). */
@Controller('hooks')
export class HooksController {
  constructor(@Inject(TriggerService) private readonly triggers: TriggerService) {}

  @Public()
  @Post(':workflowId')
  @HttpCode(202)
  async receive(@Param('workflowId') workflowId: string, @Headers('x-relay-secret') secret: string | undefined, @Body() body: unknown) {
    const run = await this.triggers.triggerWebhook(workflowId, secret, body);
    return { run_id: run.id, status: run.status };
  }
}
