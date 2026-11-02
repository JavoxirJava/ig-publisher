import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ENV_FILE = process.env.IG_ENV_FILE ?? join(ROOT, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export type UploadMode = 'auto' | 'resumable' | 'url';
export type HostKind = 'tunnel' | 'static' | 'command' | 'none';
/** instagram: Instagram Login (graph.instagram.com); facebook: Facebook Login + linked Page (graph.facebook.com). */
export type LoginKind = 'instagram' | 'facebook';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const login = env('IG_LOGIN', 'instagram') as LoginKind;

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function findBinary(envName: string, name: string): string {
  const explicit = env(envName);
  if (explicit) return explicit;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return '';
}

export const config = {
  login,
  /** Facebook Login only: which Page to use when the user manages several (default: the first with Instagram linked). */
  pageId: env('IG_PAGE_ID'),
  /** Facebook Login only: pick the Page by its linked Instagram username (instead of IG_PAGE_ID). */
  username: env('IG_USERNAME').replace(/^@/, '').toLowerCase(),
  /** Second account: its own IG_ENV_FILE + IG_DATA_DIR, and a timer named `ig-publisher-<profile>`. */
  profile: env('IG_PROFILE'),
  appId: env('IG_APP_ID'),
  appSecret: env('IG_APP_SECRET'),
  redirectUri: env('IG_REDIRECT_URI', 'https://localhost/'),
  scopes: env(
    'IG_SCOPES',
    'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights',
  ),
  apiVersion: env('IG_API_VERSION', 'v26.0'),
  graphBase: env('IG_GRAPH_BASE', login === 'facebook' ? 'https://graph.facebook.com' : 'https://graph.instagram.com'),
  oauthBase: env('IG_OAUTH_BASE', 'https://api.instagram.com'),
  authorizeBase: env('IG_AUTHORIZE_BASE', 'https://www.instagram.com'),
  ruploadBase: env('IG_RUPLOAD_BASE', 'https://rupload.facebook.com'),
  /** Optional bootstrap token; `ig auth token` stores it in the DB instead. */
  bootstrapToken: env('IG_ACCESS_TOKEN'),

  uploadMode: env('IG_UPLOAD_MODE', 'auto') as UploadMode,
  host: env('IG_HOST', 'tunnel') as HostKind,
  staticDir: env('IG_STATIC_DIR'),
  staticBaseUrl: env('IG_STATIC_BASE_URL'),
  hostCommand: env('IG_HOST_COMMAND'),
  cloudflared: findBinary('CLOUDFLARED_PATH', 'cloudflared'),
  ffmpeg: findBinary('FFMPEG_PATH', 'ffmpeg'),
  ffprobe: findBinary('FFPROBE_PATH', 'ffprobe'),

  pollIntervalMs: num('IG_POLL_INTERVAL_MS', 10_000),
  pollTimeoutMs: num('IG_POLL_TIMEOUT_MS', 20 * 60_000),
  /** Refresh the long-lived token when fewer than this many days remain. */
  refreshBeforeDays: num('IG_REFRESH_BEFORE_DAYS', 30),
  queueMaxAttempts: num('IG_QUEUE_MAX_ATTEMPTS', 3),
  retryBaseMs: num('IG_RETRY_BASE_MS', 2_000),

  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  telegramChatId: env('TELEGRAM_CHAT_ID'),

  dataDir: env('IG_DATA_DIR', join(ROOT, 'data')),
};

export function graphUrl(path: string): string {
  return `${config.graphBase}/${config.apiVersion}/${path.replace(/^\//, '')}`;
}
