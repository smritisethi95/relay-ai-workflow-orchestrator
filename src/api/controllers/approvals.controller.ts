import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApprovalService, type ApprovalView } from '../../core/services/approval.service.js';

// Single demo token covers every persona; the decider field still exists and is recorded.
const DECIDED_BY = 'demo-user';

function present(a: ApprovalView) {
  return {
    id: a.id,
    run_id: a.run_id,
    workflow_id: a.workflow_id,
    node_id: a.node_id,
    message: a.message,
    status: a.status,
    decided_by: a.decided_by ?? null,
    decided_at: a.decided_at ?? null,
    comment: a.comment ?? null,
    created_at: a.created_at,
  };
}

const commentOf = (body: unknown): unknown => (body && typeof body === 'object' ? (body as { comment?: unknown }).comment : undefined);

@Controller('approvals')
export class ApprovalsController {
  constructor(@Inject(ApprovalService) private readonly approvals: ApprovalService) {}

  @Get()
  async list(@Query('status') status?: string) {
    return (await this.approvals.list(status)).map(present);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return present(await this.approvals.get(id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: unknown) {
    return present(await this.approvals.approve(id, DECIDED_BY, commentOf(body)));
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@Param('id') id: string, @Body() body: unknown) {
    return present(await this.approvals.reject(id, DECIDED_BY, commentOf(body)));
  }
}
