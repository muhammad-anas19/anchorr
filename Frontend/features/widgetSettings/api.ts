import { request } from '../../shared/api/client';

export interface WidgetSettings {
  publicKey: string;
  allowedOrigins: string[];
}

export function getWidgetSettings(workspaceId: number): Promise<WidgetSettings> {
  return request(`/workspaces/${workspaceId}/widget-settings`);
}

export function updateAllowedOrigins(workspaceId: number, allowedOrigins: string[]): Promise<WidgetSettings> {
  return request(`/workspaces/${workspaceId}/widget-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ allowedOrigins }),
  });
}
