import type { Trace } from '../core/schema';

export interface SessionInfo {
  retentionDays: number;
  maxReports: number;
}

export interface SavedReportSummary {
  id: string;
  title: string;
  origin: 'fixture' | 'captured';
  createdAt: string;
  actionCount: number;
}

export interface SavedReport extends SavedReportSummary {
  trace: Trace;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public requestId?: string,
    public retryAfter?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ApiError('Report storage is unavailable. You can still evaluate traces and export them locally.', response.status);
    }
    const body: unknown = await response.json();
    if (!response.ok) {
      const details = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
      throw new ApiError(
        typeof details.error === 'string' ? details.error : 'The request could not be completed.',
        response.status,
        typeof details.requestId === 'string' ? details.requestId : undefined,
        response.headers.get('retry-after') ?? undefined,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError('Storage response timed out. Refresh saved reports before retrying a save.');
    }
    throw new ApiError('Could not connect to report storage. Local evaluation and export are still available.');
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function ensureSession(): Promise<SessionInfo> {
  try {
    return await request<SessionInfo>('/api/session');
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    return request<SessionInfo>('/api/session', { method: 'POST', body: '{}' });
  }
}

export async function listReports(): Promise<SavedReportSummary[]> {
  const body = await request<{ reports: SavedReportSummary[] }>('/api/reports');
  return body.reports;
}

export async function saveReport(trace: Trace): Promise<SavedReport> {
  const body = await request<{ report: SavedReport }>('/api/reports', {
    method: 'POST',
    body: JSON.stringify({ trace }),
  });
  return body.report;
}

export async function loadReport(id: string): Promise<SavedReport> {
  const body = await request<{ report: SavedReport }>(`/api/reports/${encodeURIComponent(id)}`);
  return body.report;
}

export async function deleteReport(id: string): Promise<void> {
  await request(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
