import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { config, type HostKind } from '../config.ts';
import { log } from '../log.ts';
import { startTunnel } from './tunnel.ts';

const run = promisify(execFile);

/** Makes local files reachable over public HTTPS for Instagram to fetch (image_url, video_url, cover_url). */
export interface Host {
  readonly kind: HostKind;
  url(localPath: string): Promise<string>;
  close(): Promise<void>;
}

export function isRemote(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

function safeName(path: string): string {
  const ext = extname(path).toLowerCase();
  const stem = basename(path, extname(path)).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'file';
  return `${randomBytes(6).toString('hex')}-${stem}${ext}`;
}

class NoHost implements Host {
  readonly kind = 'none' as const;
  async url(path: string): Promise<string> {
    throw new Error(
      `"${basename(path)}" uchun public URL kerak, lekin IG_HOST=none. .env da IG_HOST=tunnel|static|command ni sozlang`,
    );
  }
  async close() {}
}

class StaticHost implements Host {
  readonly kind = 'static' as const;
  private copied: string[] = [];
  async url(path: string): Promise<string> {
    if (!config.staticDir || !config.staticBaseUrl) {
      throw new Error('IG_HOST=static uchun IG_STATIC_DIR va IG_STATIC_BASE_URL kerak');
    }
    mkdirSync(config.staticDir, { recursive: true });
    const name = safeName(path);
    const dest = join(config.staticDir, name);
    copyFileSync(path, dest);
    this.copied.push(dest);
    return `${config.staticBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
  }
  async close() {
    for (const f of this.copied) rmSync(f, { force: true });
    this.copied = [];
  }
}

/** Runs IG_HOST_COMMAND with the file path as $1; the last stdout line must be the public URL. */
class CommandHost implements Host {
  readonly kind = 'command' as const;
  async url(path: string): Promise<string> {
    if (!config.hostCommand) throw new Error('IG_HOST=command uchun IG_HOST_COMMAND kerak');
    const { stdout } = await run('sh', ['-c', config.hostCommand, 'ig-host', path], { timeout: 10 * 60_000 });
    const url = stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!isRemote(url)) throw new Error(`IG_HOST_COMMAND URL qaytarmadi: "${url.slice(0, 200)}"`);
    return url;
  }
  async close() {}
}

class TunnelHost implements Host {
  readonly kind = 'tunnel' as const;
  private tunnel?: Promise<Awaited<ReturnType<typeof startTunnel>>>;
  async url(path: string): Promise<string> {
    this.tunnel ??= startTunnel();
    const t = await this.tunnel;
    return t.add(path, safeName(path));
  }
  async close() {
    if (!this.tunnel) return;
    const t = await this.tunnel.catch(() => undefined);
    this.tunnel = undefined;
    await t?.close();
    log('tunnel yopildi');
  }
}

export function openHost(kind: HostKind = config.host): Host {
  switch (kind) {
    case 'tunnel':
      return new TunnelHost();
    case 'static':
      return new StaticHost();
    case 'command':
      return new CommandHost();
    case 'none':
      return new NoHost();
    default:
      throw new Error(`noma’lum IG_HOST: ${kind}`);
  }
}
