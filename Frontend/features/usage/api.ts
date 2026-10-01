import { query, request } from '../../shared/api/client';

export type QuotaStatus =
  | { state: 'unlimited' }
  | {
      state: 'active' | 'exhausted' | 'ended';
      allowance: number;
      used: number;
      remaining: number;
      periodStart: string;
      periodEnd: string;
      source: string;
    };

export interface DailyUsage {
  day: string; // YYYY-MM-DD, a UTC day
  answers: number;
  billableAnswers: number;
  chunksEmbedded: number;
  totalTokens: number;
}

export interface UsageReport {
  range: { from: string; to: string; timezone: 'UTC' };
  answers: {
    total: number;
    billable: number;
    byStatus: { answered: number; refused: number; escalated: number };
    cacheHits: number;
    promptTokens: number;
    totalTokens: number;
  };
  chunksEmbedded: { total: number; billable: number; characters: number };
  daily: DailyUsage[];
  quota: QuotaStatus;
  rateLimit: { burst: number; perMinute: number; available: number | null };
}

export function getUsage(
  workspaceId: number,
  range: { from?: string; to?: string },
  signal?: AbortSignal,
): Promise<UsageReport> {
  return request(`/workspaces/${workspaceId}/usage${query(range)}`, { signal });
}
