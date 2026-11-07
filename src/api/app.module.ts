import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Catalog } from '../core/catalog/catalog.js';
import { ApprovalService } from '../core/services/approval.service.js';
import { RunService } from '../core/services/run.service.js';
import { TriggerService } from '../core/services/trigger.service.js';
import { WorkflowService } from '../core/services/workflow.service.js';
import { closeMongo } from '../infra/db/mongo.js';
import { AuthGuard } from './auth.js';
import type { AppContext } from './context.js';
import { HttpErrorFilter } from './http-error.filter.js';
import { ApprovalsController } from './controllers/approvals.controller.js';
import { HooksController } from './controllers/hooks.controller.js';
import { RunsController } from './controllers/runs.controller.js';
import { SystemController } from './controllers/system.controller.js';
import { WorkflowsController } from './controllers/workflows.controller.js';

/** Thin HTTP shell: providers are pre-built core objects from the composition root. */
@Module({})
export class AppModule implements OnApplicationShutdown {
  static register(ctx: AppContext): DynamicModule {
    return {
      module: AppModule,
      controllers: [SystemController, WorkflowsController, HooksController, RunsController, ApprovalsController],
      providers: [
        { provide: Catalog, useValue: ctx.catalog },
        { provide: WorkflowService, useValue: ctx.workflows },
        { provide: TriggerService, useValue: ctx.triggers },
        { provide: RunService, useValue: ctx.runs },
        { provide: ApprovalService, useValue: ctx.approvals },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await closeMongo();
  }
}
