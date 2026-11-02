import { config, graphUrl } from '../config.ts';
import { log, redact } from '../log.ts';

export type Params = Record<string, string | number | boolean | object | undefined | null>;

export class GraphError extends Error {
  status: number;
  code?: number;
  subcode?: number;
  type?: string;
  fbtraceId?: string;
  transient: boolean;

  constructor(message: string, status: number, body?: any) {
    const e = body?.error ?? {};
    super(redact(e.error_user_msg || e.message || message));
    this.name = 'GraphError';
    this.status = status;
    this.code = e.code;
    this.subcode = e.error_subcode;
    this.type = e.type;
    this.fbtraceId = e.fbtrace_id;
    // 1/2 = temporary API issue, 4/17/32/613 = rate limiting, 5xx = server side
    this.transient = Boolean(e.is_transient) || [1, 2].includes(e.code) || status >= 500 || status === 0;
  }

  get isAuth(): boolean {
    return this.code === 190 || this.code === 102 || this.status === 401;
  }

  get isRateLimit(): boolean {
    return [4, 17, 32, 613].includes(this.code ?? -1) || this.subcode === 2207042;
  }

  describe(): string {
    const parts = [this.message];
    if (this.code !== undefined) parts.push(`code=${this.code}${this.subcode ? `/${this.subcode}` : ''}`);
    if (this.fbtraceId) parts.push(`trace=${this.fbtraceId}`);
    if (this.isAuth) parts.push('— token yaroqsiz yoki muddati o‘tgan: `ig auth token` yoki `ig auth login`');
    return parts.join(' ');
  }
}

export function encodeParams(params: Params): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return out;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  params?: Params;
  token?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  retries?: number;
  /** Full URL instead of a graph path. */
  url?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const params = { ...opts.params };
  if (opts.token) params.access_token = opts.token;
  const encoded = encodeParams(params);
  let url = opts.url ?? graphUrl(path);
  let body = opts.body;
  const headers: Record<string, string> = { ...opts.headers };
  if (method === 'GET' || method === 'DELETE' || body !== undefined) {
    const qs = encoded.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  } else {
    body = encoded;
  }

  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let json: any;
    try {
      const init: RequestInit & { duplex?: 'half' } = { method, headers, body, signal: AbortSignal.timeout(10 * 60_000) };
      if (body instanceof ReadableStream) init.duplex = 'half';
      const res = await fetch(url, init);
      status = res.status;
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { error: { message: `HTTP ${status}: ${text.slice(0, 300)}` } };
      }
      if (res.ok && !json?.error) return json as T;
    } catch (err) {
      json = { error: { message: `network: ${(err as Error).message}` } };
    }
    const error = new GraphError(`HTTP ${status}`, status, json);
    // Bodies that are streams can't be resent; callers handle their own retry in that case.
    const resendable = !(body instanceof ReadableStream);
    if (attempt < retries && resendable && (error.transient || error.isRateLimit)) {
      const wait = Math.min(60_000, config.retryBaseMs * 2 ** attempt);
      log(`${method} ${redact(path || url)}: ${error.message} — ${wait / 1000}s dan keyin qayta urinish`);
      await sleep(wait);
      continue;
    }
    throw error;
  }
}
