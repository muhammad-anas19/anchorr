export enum Permission {
  MEMBERS_VIEW = 'members.view',
  MEMBERS_MANAGE = 'members.manage',
  MEMBERS_INVITE = 'members.invite',

  DOCUMENTS_VIEW = 'documents.view',
  DOCUMENTS_MANAGE = 'documents.manage',

  KNOWLEDGE_QUERY = 'knowledge.query',

  HANDOFF_VIEW = 'handoff.view',
  HANDOFF_WORK = 'handoff.work',

  WIDGET_VIEW = 'widget.view',
  WIDGET_MANAGE = 'widget.manage',

  WORKSPACE_LEAVE = 'workspace.leave',
  WORKSPACE_TRANSFER_OWNERSHIP = 'workspace.transfer_ownership',

  USAGE_VIEW = 'usage.view',
}

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);
