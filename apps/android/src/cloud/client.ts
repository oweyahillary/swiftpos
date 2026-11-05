/**
 * client.ts — the app's one way to the ZapTill cloud.
 *
 * Through CapacitorHttp (the native HTTP stack), not the WebView's fetch: the request has no web origin, so the cloud's
 * CORS list needs no entry for the app, and a session header is never exposed to page scripts beyond this module.
 * Every path is relative to the cloud's /api (config.ts).
 */
import { CapacitorHttp } from '@capacitor/core';
import { API_URL } from '../config';

export class CloudError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) { super(message); }
}

/** The cloud's /api URL of a path ("/app-update/android/status" → https://…/api/app-update/android/status). */
export function apiUrl(path: string): string { return `${API_URL}/api${path.startsWith('/') ? path : `/${path}`}`; }

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string | null,
  extra: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await CapacitorHttp.request({ method, url: apiUrl(path), headers, data: body, connectTimeout: 15_000, readTimeout: 20_000 });
  } catch {
    throw new CloudError('Could not reach ZapTill. Check the internet connection.', 0, 'OFFLINE');
  }
  const data = res.data as { error?: string; code?: string } | T;
  if (res.status >= 200 && res.status < 300) return data as T;
  const err = (data ?? {}) as { error?: string; code?: string };
  throw new CloudError(err.error || `ZapTill answered ${res.status}.`, res.status, err.code ?? null);
}

/** extra: headers of the caller's own — Till stage 1: the Shop POS names itself (x-device-id) on its own session's calls. */
export const cloudGet = <T>(path: string, token?: string | null, extra?: Record<string, string>) => request<T>('GET', path, undefined, token, extra);
export const cloudPost = <T>(path: string, body: unknown, token?: string | null, extra?: Record<string, string>) => request<T>('POST', path, body, token, extra);
