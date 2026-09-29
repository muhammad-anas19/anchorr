import { SetMetadata } from '@nestjs/common';
import { Permission } from '../permissions/permission.enum';

export const PERMISSION_KEY = 'requiredPermission';

// One permission per route, deliberately. "Requires A or B" is how role lists crept in before
// (@Roles(OWNER, AGENT) was really "whoever can do this"); if a route genuinely needs two
// different capabilities, that is usually a sign it is doing two things.
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
