// In-process fake of graph.instagram.com + rupload + oauth, enough to drive the full publish flow.
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface MockState {
  containers: Map<string, { params: Record<string, string>; polls: number; uploadedBytes?: number; status?: string }>;
  published: { creationId: string; mediaId: string }[];
  calls: { method: string; path: string; params: Record<string, string> }[];
  /** Reject `upload_type=resumable` like an account without Facebook Login would. */
  resumableUnsupported: boolean;
  /** How many status polls return IN_PROGRESS before FINISHED. */
  pollsUntilFinished: number;
  /** Force the next N container statuses to ERROR. */
  failNextContainers: number;
  /** Fail media_publish with a transient error this many times. */
  publishTransientFailures: number;
  quotaUsage: number;
  refreshes: number;
  tokenValid: Set<string>;
}

export interface Mock {
  base: string;
  state: MockState;
  server: Server;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startMock(): Promise<Mock> {
  let seq = 1000;
  const state: MockState = {
    containers: new Map(),
    published: [],
    calls: [],
    resumableUnsupported: false,
    pollsUntilFinished: 1,
    failNextContainers: 0,
    publishTransientFailures: 0,
    quotaUsage: 0,
    refreshes: 0,
    tokenValid: new Set(['TEST_TOKEN']),
  };
  let base = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    if (req.headers['content-type']?.includes('x-www-form-urlencoded')) {
      Object.assign(params, Object.fromEntries(new URLSearchParams(body.toString())));
    }
    const path = url.pathname;
    state.calls.push({ method: req.method ?? 'GET', path, params });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    };
    const fail = (status: number, code: number, message: string, extra: object = {}) =>
      json(status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'TRACE', ...extra } });

    // rupload: Authorization header carries the token
    let m = /^\/ig-api-upload\/v[\d.]+\/(\d+)$/.exec(path);
    if (m) {
      const c = state.containers.get(m[1]);
      if (!c) return fail(400, 100, 'unknown container');
      if (!/^OAuth \S+/.test(String(req.headers.authorization))) return fail(401, 190, 'no auth');
      if (Number(req.headers.file_size) !== body.length) return fail(400, 100, 'file_size mismatch');
      c.uploadedBytes = body.length;
      return json(200, { success: true, message: 'Upload successful.' });
    }

    if (path === '/oauth/access_token' && req.method === 'POST') {
      if (params.code !== 'GOODCODE') return fail(400, 100, 'bad code');
      state.tokenValid.add('SHORT_TOKEN');
      return json(200, { data: [{ access_token: 'SHORT_TOKEN', user_id: '17841400000000001', permissions: 'instagram_business_basic,instagram_business_content_publish' }] });
    }
    if (path === '/access_token') {
      if (params.access_token !== 'SHORT_TOKEN') return fail(400, 100, 'not a short-lived token');
      state.tokenValid.add('LONG_TOKEN');
      return json(200, { access_token: 'LONG_TOKEN', token_type: 'bearer', expires_in: 5184000 });
    }
    if (path === '/refresh_access_token') {
      if (!state.tokenValid.has(params.access_token)) return fail(400, 190, 'invalid token');
      state.refreshes++;
      const next = `REFRESHED_${state.refreshes}`;
      state.tokenValid.add(next);
      return json(200, { access_token: next, token_type: 'bearer', expires_in: 5184000 });
    }

    // Facebook Login: short user token → long-lived user token
    if (/^\/v[\d.]+\/oauth\/access_token$/.test(path) && params.grant_type === 'fb_exchange_token') {
      if (params.fb_exchange_token !== 'FB_USER_TOKEN' || params.client_secret !== 'secret') return fail(400, 190, 'bad token');
      state.tokenValid.add('FB_LONG_USER_TOKEN');
      return json(200, { access_token: 'FB_LONG_USER_TOKEN', token_type: 'bearer', expires_in: 5184000 });
    }

    const token = params.access_token;
    if (!token || !state.tokenValid.has(token)) return fail(400, 190, 'Error validating access token');

    m = /^\/v[\d.]+\/(.+)$/.exec(path);
    const rest = m?.[1] ?? '';

    if (rest === 'me/accounts' && token === 'FB_LONG_USER_TOKEN') {
      state.tokenValid.add('FB_PAGE_TOKEN');
      state.tokenValid.add('SECOND_PAGE_TOKEN');
      return json(200, { data: [
        { id: '500', name: 'Boshqa sahifa', access_token: 'OTHER_PAGE_TOKEN' },
        { id: '501', name: 'Test sahifa', access_token: 'FB_PAGE_TOKEN', instagram_business_account: { id: '17841400000000002', username: 'test_fb' } },
        { id: '502', name: 'Ikkinchi sahifa', access_token: 'SECOND_PAGE_TOKEN', instagram_business_account: { id: '17841400000000003', username: 'second_ig' } },
      ] });
    }
    if (rest === 'me' && token === 'FB_PAGE_TOKEN') {
      return json(200, { id: '501', instagram_business_account: { id: '17841400000000002', username: 'test_fb', media_count: 5 } });
    }
    if (rest === 'me' && token === 'SECOND_PAGE_TOKEN') {
      return json(200, { id: '502', instagram_business_account: { id: '17841400000000003', username: 'second_ig', media_count: 1 } });
    }
    if (/^\d+\/media$/.test(rest) && req.method === 'GET') {
      return json(200, { data: state.published.map((p) => ({ id: p.mediaId, media_product_type: 'REELS' })) });
    }

    if (rest === 'me') {
      return json(200, { user_id: '17841400000000001', id: '9000', username: 'test_biz', account_type: 'BUSINESS', media_count: 3 });
    }
    if (/^\d+\/content_publishing_limit$/.test(rest)) {
      return json(200, { data: [{ quota_usage: state.quotaUsage, config: { quota_total: 100, quota_duration: 86400 } }] });
    }
    if (/^\d+\/media$/.test(rest) && req.method === 'POST') {
      if (params.upload_type === 'resumable' && state.resumableUnsupported) {
        return fail(400, 100, 'Unsupported upload_type for this login type');
      }
      if (!params.upload_type && !params.image_url && !params.video_url && params.media_type !== 'CAROUSEL') {
        return fail(400, 100, 'media url required');
      }
      const id = String(++seq);
      const status = state.failNextContainers > 0 ? (state.failNextContainers--, 'ERROR') : undefined;
      state.containers.set(id, { params, polls: 0, status });
      const out: Record<string, string> = { id };
      if (params.upload_type === 'resumable') out.uri = `${base}/ig-api-upload/v26.0/${id}`;
      return json(200, out);
    }
    if (/^\d+\/media_publish$/.test(rest) && req.method === 'POST') {
      if (state.publishTransientFailures > 0) {
        state.publishTransientFailures--;
        return fail(500, 2, 'Service temporarily unavailable', { is_transient: true });
      }
      const c = state.containers.get(params.creation_id);
      if (!c) return fail(400, 100, 'unknown creation_id');
      const mediaId = `9${params.creation_id}`;
      c.status = 'PUBLISHED';
      state.published.push({ creationId: params.creation_id, mediaId });
      return json(200, { id: mediaId });
    }
    if (/^\d+$/.test(rest) && req.method === 'GET') {
      const c = state.containers.get(rest);
      if (c) {
        if (c.params.upload_type === 'resumable' && c.uploadedBytes === undefined) {
          return json(200, { id: rest, status_code: 'IN_PROGRESS', status: 'waiting for upload' });
        }
        c.polls++;
        const code = c.status ?? (c.polls > state.pollsUntilFinished ? 'FINISHED' : 'IN_PROGRESS');
        return json(200, { id: rest, status_code: code, status: code === 'ERROR' ? 'Error: 2207026 unsupported video' : code });
      }
      const pub = state.published.find((p) => p.mediaId === rest);
      if (pub) return json(200, { id: rest, permalink: `https://www.instagram.com/reel/MOCK${rest}/`, media_product_type: 'REELS' });
      return fail(400, 100, 'Unsupported get request');
    }
    return fail(404, 100, `mock: no route ${req.method} ${path}`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return {
    base,
    state,
    server,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/** Points the app at the mock; must run before the app modules are imported. */
export function mockEnv(mock: Mock, dataDir: string): void {
  Object.assign(process.env, {
    IG_ENV_FILE: '/nonexistent',
    IG_GRAPH_BASE: mock.base,
    IG_OAUTH_BASE: mock.base,
    IG_RUPLOAD_BASE: mock.base,
    IG_DATA_DIR: dataDir,
    IG_APP_ID: '123',
    IG_APP_SECRET: 'secret',
    IG_HOST: 'command',
    IG_HOST_COMMAND: 'echo "https://files.example.test/$(basename "$1")"',
    IG_POLL_INTERVAL_MS: '20',
    IG_POLL_TIMEOUT_MS: '5000',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
  });
}
