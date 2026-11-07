import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { RunService } from '../../core/services/run.service.js';
import { presentRun, presentRunSummary } from '../presenters.js';

@Controller('runs')
export class RunsController {
  constructor(@Inject(RunService) private readonly runs: RunService) {}

  @Get()
  async list(@Query('workflow_id') workflowId?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return (await this.runs.list({ workflow_id: workflowId, status, limit })).map(presentRunSummary);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return presentRun(await this.runs.get(id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string) {
    const run = await this.runs.cancel(id);
    return { run_id: run.id, status: run.status, cancel_requested: run.cancel_requested, ended_by: run.ended_by };
  }
}
