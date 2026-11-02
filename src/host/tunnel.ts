import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { config } from '../config.ts';
import { log } from '../log.ts';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export interface FileServer {
  server: Server;
  port: number;
  secret: string;
  files: Map<string, string>;
}

/** Serves only explicitly registered files under an unguessable prefix, with Range support for video fetchers. */
export async function startFileServer(): Promise<FileServer> {
  const secret = randomBytes(16).toString('hex');
  const files = new Map<string, string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const [, prefix, name] = url.pathname.split('/');
    const path = prefix === secret && name ? files.get(decodeURIComponent(name)) : undefined;
    if (!path || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    const size = statSync(path).size;
    const headers: Record<string, string | number> = {
      'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1 });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': size });
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(path, { start, end }).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, port, secret, files };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReachable(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  // Ask Cloudflare's resolver first: probing through the system resolver too early
  // gets NXDOMAIN negatively cached for about a minute.
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '1.0.0.1']);
  const host = new URL(url).hostname;
  while (Date.now() < deadline) {
    try {
      if ((await resolver.resolve4(host)).length) break;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(1_000);
  }
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(2_000);
  }
  throw new Error(`tunnel URL ochilmadi (${last})`);
}

/** Cloudflare quick tunnel (https://*.trycloudflare.com) in front of the local file server. */
export async function startTunnel() {
  if (!config.cloudflared) throw new Error('cloudflared topilmadi (CLOUDFLARED_PATH) — yoki IG_HOST=static|command');
  const fs = await startFileServer();
  // An existing ~/.cloudflared/config.yml (named tunnel) would hijack the quick tunnel, so point at an empty one.
  const cfgDir = mkdtempSync(join(tmpdir(), 'ig-cf-'));
  const cfg = join(cfgDir, 'config.yml');
  writeFileSync(cfg, '{}\n');
  const child = spawn(
    config.cloudflared,
    ['tunnel', '--config', cfg, '--no-autoupdate', '--url', `http://127.0.0.1:${fs.port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cloudflared URL bermadi:\n${output.slice(-800)}`)), 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output);
      // the URL is printed before the edge connection exists; wait for registration too
      if (m && /Registered tunnel connection/i.test(output)) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared to‘xtadi (code ${code}):\n${output.slice(-800)}`));
    });
  }).catch((err) => {
    child.kill();
    fs.server.close();
    rmSync(cfgDir, { recursive: true, force: true });
    throw err;
  });
  log(`tunnel ochildi: ${base}`);

  let verified = false;
  return {
    base,
    async add(path: string, name: string): Promise<string> {
      fs.files.set(name, path);
      const url = `${base}/${fs.secret}/${encodeURIComponent(name)}`;
      if (!verified) {
        await waitReachable(url, 90_000);
        verified = true;
      }
      return url;
    },
    async close() {
      child.kill('SIGTERM');
      fs.server.closeAllConnections();
      await new Promise((r) => fs.server.close(r));
      rmSync(cfgDir, { recursive: true, force: true });
    },
  };
}
