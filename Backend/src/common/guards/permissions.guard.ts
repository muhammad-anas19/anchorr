import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '../permissions/permission.enum';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { TenantContextService } from '../../modules/tenancy/tenant-context.service';
import { PermissionsService } from '../../modules/tenancy/permissions.service';

// Runs after WorkspaceGuard, which has already proved membership and put the caller's role in
// TenantContextService.
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler first, then class. The old RolesGuard read only the handler, which is why a
    // class-level @Roles in Phase 12 was silently never enforced; getAllAndOverride reads both,
    // with the method's own declaration winning.
    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Deny by default. The old guard ALLOWED any route with no @Roles — so forgetting the
    // decorator on a new route made it open to every member, and nothing would ever notice.
    // Here forgetting it makes the route fail closed for everyone, which the first test (or
    // the first click) notices immediately. A route meant to be open to every member says so
    // explicitly with a permission every role holds.
    if (!required) {
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} has no @RequirePermission — denied by default.`,
      );
      throw new ForbiddenException('This action is not permitted.');
    }

    if (!this.permissions.has(this.tenantContext.role, required)) {
      throw new ForbiddenException(`Your role does not have the "${required}" permission.`);
    }
    return true;
  }
}
