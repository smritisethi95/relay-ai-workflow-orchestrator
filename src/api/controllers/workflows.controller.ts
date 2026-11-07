import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { TriggerService } from '../../core/services/trigger.service.js';
import { WorkflowService } from '../../core/services/workflow.service.js';
import { presentValidation, presentWorkflow } from '../presenters.js';

@Controller('workflows')
export class WorkflowsController {
  constructor(
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(TriggerService) private readonly triggers: TriggerService,
  ) {}

  @Get()
  list() {
    return this.workflows.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return presentWorkflow(await this.workflows.get(id));
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const { workflow, validation } = await this.workflows.create(body);
    return { id: workflow.id, status: workflow.status, version: workflow.version, validation: presentValidation(validation) };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const { workflow, validation } = await this.workflows.updateDraft(id, body);
    return { id: workflow.id, status: workflow.status, version: workflow.version, validation: presentValidation(validation) };
  }

  @Post(':id/publish')
  @HttpCode(200)
  async publish(@Param('id') id: string) {
    const { workflow, warnings } = await this.workflows.publish(id);
    return { id: workflow.id, status: workflow.status, version: workflow.version, published_at: workflow.published_at, warnings };
  }

  @Post(':id/trigger')
  @HttpCode(202)
  async trigger(@Param('id') id: string, @Body() body: unknown) {
    const input = body && typeof body === 'object' && !Array.isArray(body) ? ((body as { input?: unknown }).input ?? {}) : body;
    const run = await this.triggers.triggerManual(id, input);
    return { run_id: run.id, status: run.status };
  }
}
