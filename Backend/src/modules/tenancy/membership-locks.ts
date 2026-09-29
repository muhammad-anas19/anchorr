import { ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

// For an action that must only COMPLETE while the caller is still a member — not merely have
// been one when the request arrived.
//
// FOR SHARE is a read lock on the membership row: any number of these can be held at once (two
// agents claiming two conversations don't block each other), but it blocks a DELETE or UPDATE of
// that row until the holding transaction ends. So against a concurrent removal, exactly one of
// two orders happens:
//   - the action locks first → the removal waits for it to commit → the removal then sees what
//     the action did (e.g. the just-claimed session) and cleans it up;
//   - the removal commits first → this SELECT finds no row → the action is refused.
// What can no longer happen is the in-between: the action finishing after the removal's cleanup.
//
// It must run inside the same transaction as the action it protects; the lock lasts until that
// transaction ends.
export async function lockMembershipForShare(manager: EntityManager, workspaceId: number, userId: number): Promise<void> {
  const rows = await manager.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR SHARE`,
    [workspaceId, userId],
  );
  if (rows.length === 0) {
    throw new ForbiddenException('You are no longer a member of this workspace.');
  }
}
