import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '../core/domain/errors.js';
import { secretsMatch } from '../core/guardrails/secrets.js';
import { config } from '../config.js';

const IS_PUBLIC = 'relay:isPublic';

/** Marks a route as reachable without the platform bearer token (health, webhooks, console). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token || !secretsMatch(token, config.demoToken)) {
      throw new DomainError('unauthorized', 'Missing or invalid bearer token', 401);
    }
    return true;
  }
}
