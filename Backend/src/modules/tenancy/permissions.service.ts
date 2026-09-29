import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { ALL_PERMISSIONS, Permission } from '../../common/permissions/permission.enum';

// Answers "may this role do this?" from an in-memory copy of role_permissions.
//
// Why cache, and why that is safe here: this check runs on every workspace request, and the
// policy changes rarely (a migration or an admin edit, not user traffic). Loading once at boot
// turns a per-request query into a Set lookup.
// The cost is staleness: an edit to role_permissions takes effect when reload() runs — on the
// next boot, or when whatever makes the edit calls it. With several API instances each holds its
// own copy, so an edit made at runtime would need a broadcast (Redis pub/sub) to reach them all.
// No runtime edit path exists yet, so boot-time loading is the whole story for now.
@Injectable()
export class PermissionsService implements OnModuleInit {
  private readonly logger = new Logger(PermissionsService.name);
  private byRole = new Map<MembershipRole, ReadonlySet<Permission>>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const [catalogue, grants] = await Promise.all([
      this.dataSource.query<Array<{ key: string }>>(`SELECT key FROM permissions`),
      this.dataSource.query<Array<{ role: MembershipRole; permission_key: string }>>(
        `SELECT role, permission_key FROM role_permissions`,
      ),
    ]);

    this.assertNoDrift(catalogue.map((row) => row.key));

    const next = new Map<MembershipRole, Set<Permission>>();
    for (const role of Object.values(MembershipRole)) next.set(role, new Set());
    for (const grant of grants) {
      next.get(grant.role)?.add(grant.permission_key as Permission);
    }
    this.byRole = next;
  }

  // Read on demand rather than cached: only the role matrix screen needs the human wording,
  // and it is not on any hot path.
  async descriptions(): Promise<Map<string, string>> {
    const rows = await this.dataSource.query<Array<{ key: string; description: string }>>(
      `SELECT key, description FROM permissions`,
    );
    return new Map(rows.map((row) => [row.key, row.description]));
  }

  has(role: MembershipRole, permission: Permission): boolean {
    return this.byRole.get(role)?.has(permission) ?? false;
  }

  forRole(role: MembershipRole): Permission[] {
    return [...(this.byRole.get(role) ?? [])].sort();
  }

  // Drift check: the enum and the permissions table must describe the same set.
  //
  // A permission in code but missing from the database is FATAL, and deliberately loud. Without
  // this check nothing would error — has() would simply return false for every role, and the
  // feature it guards would 403 for everyone, owners included. That is the silent-degradation
  // shape this project keeps meeting (the tsquery colon, the GREATEST clamp): the failure is
  // not an exception, it is a wrong answer. Refusing to boot turns it back into a loud one,
  // at deploy time, instead of a support ticket.
  //
  // The reverse (in the database, not in code) is only a warning: an orphan row grants nothing,
  // since no code checks it — typically the leftover of a permission removed from code before
  // its cleanup migration has run.
  private assertNoDrift(databaseKeys: string[]): void {
    const inDatabase = new Set(databaseKeys);
    const missing = ALL_PERMISSIONS.filter((key) => !inDatabase.has(key));
    if (missing.length > 0) {
      throw new Error(
        `Permissions defined in code are missing from the permissions table: ${missing.join(', ')}. ` +
          `Add a migration that inserts them (and grants them to the right roles).`,
      );
    }

    const known = new Set<string>(ALL_PERMISSIONS);
    const orphans = databaseKeys.filter((key) => !known.has(key));
    if (orphans.length > 0) {
      this.logger.warn(`Permissions in the database with no code behind them: ${orphans.join(', ')}.`);
    }
  }
}
