import { Controller, ExecutionContext, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { Permission } from '../permissions/permission.enum';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { TenantContextService } from '../../modules/tenancy/tenant-context.service';
import { PermissionsService } from '../../modules/tenancy/permissions.service';

// Unit-level on purpose: these are properties of the guard's metadata handling, and proving
// "a route with no decorator is denied" end-to-end would mean shipping an undecorated route.

@Controller()
@RequirePermission(Permission.DOCUMENTS_VIEW)
class ClassLevelController {
  @Get() inherits() {}
  @Get() @RequirePermission(Permission.DOCUMENTS_MANAGE) overrides() {}
}

@Controller()
class UndecoratedController {
  @Get() forgotten() {}
}

function contextFor(cls: new () => object, method: string): ExecutionContext {
  return {
    getClass: () => cls,
    getHandler: () => (cls.prototype as Record<string, unknown>)[method],
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  // A viewer: holds documents.view, lacks documents.manage.
  const granted = new Set<Permission>([Permission.DOCUMENTS_VIEW]);
  const permissions = { has: (_role: MembershipRole, p: Permission) => granted.has(p) } as PermissionsService;
  const tenant = Object.assign(new TenantContextService(), { workspaceId: 1, role: MembershipRole.VIEWER });
  const guard = new PermissionsGuard(new Reflector(), tenant, permissions);

  it('denies a route that declares no permission at all (deny by default)', () => {
    expect(() => guard.canActivate(contextFor(UndecoratedController, 'forgotten'))).toThrow(ForbiddenException);
  });

  it('enforces a class-level permission (the old RolesGuard ignored these)', () => {
    expect(guard.canActivate(contextFor(ClassLevelController, 'inherits'))).toBe(true);
  });

  it('lets a method-level permission override the class-level one', () => {
    expect(() => guard.canActivate(contextFor(ClassLevelController, 'overrides'))).toThrow(/documents\.manage/);
  });
});
