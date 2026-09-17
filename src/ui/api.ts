import { z } from 'zod';
import { parseTrace, type Trace } from '../core/schema';

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

const sessionSchema = z.object({
  retentionDays: z.number().int().positive(),
  maxReports: z.number().int().positive(),
});
const summarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(160),
  origin: z.enum(['fixture', 'captured']),
  createdAt: z.string().datetime({ offset: true }),
  actionCount: z.number().int().min(0).max(200),
});
const reportSchema = summarySchema.extend({ trace: z.unknown() });

function decode<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      'Report storage returned an invalid response. Retry storage; your local trace is unchanged.',
    );
  return parsed.data;
}

function decodeReport(body: unknown): SavedReport {
  const { report } = decode(z.object({ report: reportSchema }), body);
  try {
    return { ...report, trace: parseTrace(report.trace) };
  } catch {
    throw new ApiError('The saved trace is invalid. Your current local trace is unchanged.');
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ApiError(
        'Report storage is unavailable. You can still evaluate traces and export them locally.',
        response.status,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        'Report storage returned an invalid response. Retry storage; your local trace is unchanged.',
        response.status,
      );
    }
    if (!response.ok) {
      const details =
        body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      throw new ApiError(
        typeof details.error === 'string' ? details.error : 'The request could not be completed.',
        response.status,
        typeof details.requestId === 'string' ? details.requestId : undefined,
        response.headers.get('retry-after') ?? undefined,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError(
        'Storage response timed out. Refresh saved reports before retrying a save.',
      );
    }
    throw new ApiError(
      'Could not connect to report storage. Local evaluation and export are still available.',
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

let sessionRequest: Promise<SessionInfo> | null = null;

async function coordinateSession(initialize: () => Promise<SessionInfo>): Promise<SessionInfo> {
  if (typeof navigator === 'undefined' || !navigator.locks) return initialize();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    return await navigator.locks.request(
      'agent-control-lab-session',
      { signal: controller.signal },
      () => {
        window.clearTimeout(timeout);
        return initialize();
      },
    );
  } catch (error) {
    if (controller.signal.aborted)
      throw new ApiError(
        'Another tab is still connecting to storage. Retry storage in a moment; your local trace is unchanged.',
      );
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function ensureSession(): Promise<SessionInfo> {
  if (sessionRequest) return sessionRequest;
  const initialize = async () => {
    try {
      return decode(sessionSchema, await request('/api/session'));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      return decode(sessionSchema, await request('/api/session', { method: 'POST', body: '{}' }));
    }
  };
  sessionRequest = coordinateSession(initialize);
  try {
    return await sessionRequest;
  } finally {
    sessionRequest = null;
  }
}

export async function listReports(): Promise<SavedReportSummary[]> {
  const body = await request('/api/reports');
  return decode(z.object({ reports: z.array(summarySchema) }), body).reports;
}

export async function saveReport(trace: Trace): Promise<SavedReport> {
  const body = await request('/api/reports', {
    method: 'POST',
    body: JSON.stringify({ trace }),
  });
  return decodeReport(body);
}

export async function loadReport(id: string): Promise<SavedReport> {
  const body = await request(`/api/reports/${encodeURIComponent(id)}`);
  return decodeReport(body);
}

export async function deleteReport(id: string): Promise<void> {
  decode(
    z.object({ ok: z.literal(true) }),
    await request(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  );
}
