import { basename } from 'node:path';
import { config } from './config.ts';
import { getDb, kvGet, kvSet } from './db.ts';
import { getAuth } from './api/auth.ts';
import { GraphError, type Params } from './api/http.ts';
import {
  createContainer,
  getMedia,
  getStatus,
  publishContainer,
  publishingLimit,
  uploadToContainer,
  waitFinished,
} from './api/publish.ts';
import { isRemote, openHost, type Host } from './host/index.ts';
import { log } from './log.ts';
import { cleanupTemp, kindOf, prepare, type Check, type Target } from './media/probe.ts';
import { notifyPublished } from './notify.ts';
import { fingerprint, normalizeSpec, type PostSpec } from './spec.ts';

export interface PublishOptions {
  dryRun?: boolean;
  /** Publish even if the same media was already published. */
  force?: boolean;
  queueId?: number;
  /** Skip the Telegram success message (e.g. tests). */
  silent?: boolean;
}

export interface PublishResult {
  postId: number;
  mediaId?: string;
  permalink?: string;
  dryRun?: boolean;
  resumed?: boolean;
  checks?: { file: string; target: Target; check: Check; prepared: string }[];
  params?: Params;
}

export class DuplicateError extends Error {
  permalink?: string;
  constructor(permalink?: string, when?: string) {
    super(`bu media allaqachon joylangan${when ? ` (${when})` : ''}${permalink ? `: ${permalink}` : ''} — qayta joylash uchun --force`);
    this.name = 'DuplicateError';
    this.permalink = permalink;
  }
}

export interface PostRow {
  id: number;
  fingerprint: string;
  type: string;
  spec: string;
  status: 'preparing' | 'uploading' | 'processing' | 'publishing' | 'published' | 'failed';
  container_id: string | null;
  children: string | null;
  media_id: string | null;
  permalink: string | null;
  error: string | null;
  queue_id: number | null;
  created_at: string;
  updated_at: string;
}

function updatePost(id: number, fields: Partial<PostRow>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  getDb()
    .prepare(`UPDATE posts SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => (fields as any)[k] ?? null), id);
}

export function getPost(id: number): PostRow | undefined {
  return getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined;
}

export function listPosts(limit = 20, status?: string): PostRow[] {
  const db = getDb();
  return (status
    ? db.prepare('SELECT * FROM posts WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT ?').all(limit)) as unknown as PostRow[];
}

const RESUMABLE_BROKEN_KEY = 'resumable_broken_until';

function resumableAllowed(): boolean {
  if (config.uploadMode === 'url') return false;
  if (config.uploadMode === 'resumable') return true;
  const until = kvGet<number>(RESUMABLE_BROKEN_KEY);
  return !until || until < Date.now();
}

function targetFor(spec: PostSpec): Target {
  return spec.type === 'image' ? 'feed' : spec.type;
}

/** Shared optional fields for the top-level container. */
function commonParams(spec: PostSpec): Params {
  const p: Params = {};
  if (spec.caption) p.caption = spec.caption;
  if (spec.collaborators?.length) p.collaborators = spec.collaborators;
  if (spec.locationId) p.location_id = spec.locationId;
  if (spec.userTags?.length) p.user_tags = spec.userTags;
  if (spec.aiGenerated) p.is_ai_generated = true;
  return p;
}

class Publisher {
  host: Host;
  token: string;
  userId: string;
  constructor(auth: { token: string; userId: string }) {
    this.host = openHost();
    this.token = auth.token;
    this.userId = auth.userId;
  }

  async publicUrl(path: string): Promise<string> {
    return isRemote(path) ? path : this.host.url(path);
  }

  /** Video container via resumable upload when possible, falling back to a public URL. */
  async videoContainer(path: string, params: Params): Promise<string> {
    if (isRemote(path)) return (await createContainer(this.userId, this.token, { ...params, video_url: path })).id;
    if (resumableAllowed()) {
      try {
        const c = await createContainer(this.userId, this.token, { ...params, upload_type: 'resumable' });
        log(`container ${c.id}: ${basename(path)} to‘g‘ridan-to‘g‘ri yuklanmoqda (resumable)`);
        await uploadToContainer(c, this.token, path);
        return c.id;
      } catch (err) {
        const e = err as GraphError;
        if (config.uploadMode === 'resumable' || e.isAuth || e.isRateLimit) throw err;
        log(`resumable ishlamadi (${e.message}) — public URL usuliga o‘tildi`);
        // Don't keep hitting a path the account doesn't support; retry it after a week.
        kvSet(RESUMABLE_BROKEN_KEY, Date.now() + 7 * 86_400_000);
      }
    }
    const url = await this.host.url(path);
    return (await createContainer(this.userId, this.token, { ...params, video_url: url })).id;
  }

  async imageContainer(path: string, params: Params): Promise<string> {
    const url = await this.publicUrl(path);
    return (await createContainer(this.userId, this.token, { ...params, image_url: url })).id;
  }

  async build(spec: PostSpec, media: string[], cover?: string): Promise<{ containerId: string; children?: string[] }> {
    const common = commonParams(spec);
    switch (spec.type) {
      case 'reel': {
        const params: Params = { ...common, media_type: 'REELS', share_to_feed: spec.shareToFeed ?? true };
        if (cover) params.cover_url = await this.publicUrl(cover);
        else if (spec.thumbOffsetMs !== undefined) params.thumb_offset = spec.thumbOffsetMs;
        if (spec.audioName) params.audio_name = spec.audioName;
        if (spec.trial) params.trial_params = { graduation_strategy: spec.trial };
        return { containerId: await this.videoContainer(media[0], params) };
      }
      case 'story': {
        const params: Params = { media_type: 'STORIES' };
        if (spec.userTags?.length) params.user_tags = spec.userTags;
        return {
          containerId:
            kindOf(media[0]) === 'video'
              ? await this.videoContainer(media[0], params)
              : await this.imageContainer(media[0], params),
        };
      }
      case 'image': {
        const params: Params = { ...common };
        if (spec.altText) params.alt_text = spec.altText;
        return { containerId: await this.imageContainer(media[0], params) };
      }
      case 'carousel': {
        const children: string[] = [];
        for (const m of media) {
          const child: Params = { is_carousel_item: true };
          if (kindOf(m) === 'video') {
            children.push(await this.videoContainer(m, { ...child, media_type: 'VIDEO' }));
          } else {
            if (spec.altText) child.alt_text = spec.altText;
            children.push(await this.imageContainer(m, child));
          }
          log(`karusel elementi ${children.length}/${media.length} tayyorlandi`);
        }
        await waitFinished(children, this.token);
        const params: Params = { ...common, media_type: 'CAROUSEL', children: children.join(',') };
        delete params.user_tags; // tags belong on the children for carousels
        return { containerId: (await createContainer(this.userId, this.token, params)).id, children };
      }
    }
  }
}

async function checkQuota(userId: string, token: string): Promise<void> {
  try {
    const q = await publishingLimit(userId, token);
    const total = q.config?.quota_total;
    if (total && q.quota_usage >= total) {
      throw new GraphError(`24 soatlik limit tugagan (${q.quota_usage}/${total})`, 429, { error: { code: 4 } });
    }
  } catch (err) {
    if (err instanceof GraphError && err.isRateLimit) throw err;
    log(`limitni tekshirib bo‘lmadi: ${(err as Error).message}`);
  }
}

/** Finish a post whose container was created earlier (crash, timeout) if Instagram still has it. */
async function tryResume(fp: string, auth: { token: string; userId: string }): Promise<PostRow | undefined> {
  const row = getDb()
    .prepare(
      `SELECT * FROM posts WHERE fingerprint = ? AND container_id IS NOT NULL
       AND status IN ('processing', 'publishing', 'failed') AND created_at > datetime('now', '-23 hours')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(fp) as PostRow | undefined;
  if (!row?.container_id) return undefined;
  try {
    const s = await getStatus(row.container_id, auth.token);
    if (s.status_code === 'FINISHED' || s.status_code === 'IN_PROGRESS') return row;
  } catch {
    /* container gone; start over */
  }
  return undefined;
}

export async function publish(input: PostSpec, opts: PublishOptions = {}): Promise<PublishResult> {
  const spec = normalizeSpec(input);
  const fp = await fingerprint(spec);
  const db = getDb();

  if (!opts.force) {
    const done = db
      .prepare(`SELECT permalink, updated_at FROM posts WHERE fingerprint = ? AND status = 'published' ORDER BY id DESC LIMIT 1`)
      .get(fp) as { permalink: string | null; updated_at: string } | undefined;
    if (done) throw new DuplicateError(done.permalink ?? undefined, done.updated_at);
  }

  // Validate / fix media first: cheap failures before any API call.
  const target = targetFor(spec);
  const allowFix = spec.fix ?? true;
  const checks: NonNullable<PublishResult['checks']> = [];
  const media: string[] = [];
  for (const m of spec.media) {
    if (isRemote(m)) {
      media.push(m);
      continue;
    }
    const t: Target = spec.type === 'carousel' ? 'carousel' : spec.type === 'story' ? 'story' : target;
    const r = await prepare(m, t, allowFix);
    checks.push({ file: m, target: t, check: r.check, prepared: r.path });
    media.push(r.path);
  }
  let cover: string | undefined;
  if (spec.cover) {
    if (isRemote(spec.cover)) cover = spec.cover;
    else {
      const r = await prepare(spec.cover, 'cover', allowFix);
      checks.push({ file: spec.cover, target: 'cover', check: r.check, prepared: r.path });
      cover = r.path;
    }
  }

  if (opts.dryRun) {
    return { postId: 0, dryRun: true, checks, params: { ...commonParams(spec), type: spec.type, media, cover } };
  }

  const auth = await getAuth();
  const resumable = opts.force ? undefined : await tryResume(fp, auth);
  if (resumable) {
    log(`#${resumable.id} avvalgi urinishdagi container ${resumable.container_id} topildi — davom ettirilmoqda`);
    cleanupTemp();
    return finish(resumable.id, resumable.container_id!, spec, auth, opts, true);
  }

  const postId = Number(
    db
      .prepare(`INSERT INTO posts(fingerprint, type, spec, status, queue_id) VALUES(?, ?, ?, 'preparing', ?)`)
      .run(fp, spec.type, JSON.stringify(spec), opts.queueId ?? null).lastInsertRowid,
  );
  const publisher = new Publisher(auth);
  try {
    await checkQuota(auth.userId, auth.token);
    updatePost(postId, { status: 'uploading' });
    const built = await publisher.build(spec, media, cover);
    updatePost(postId, {
      status: 'processing',
      container_id: built.containerId,
      children: built.children ? JSON.stringify(built.children) : null,
    });
    // The host must stay up while Instagram downloads and processes the files.
    return await finish(postId, built.containerId, spec, auth, opts, false);
  } catch (err) {
    updatePost(postId, { status: 'failed', error: err instanceof GraphError ? err.describe() : (err as Error).message });
    throw err;
  } finally {
    await publisher.host.close();
    cleanupTemp();
  }
}

async function finish(
  postId: number,
  containerId: string,
  spec: PostSpec,
  auth: { token: string; userId: string },
  opts: PublishOptions,
  resumed: boolean,
): Promise<PublishResult> {
  try {
    log(`container ${containerId}: Instagram qayta ishlamoqda...`);
    let last = '';
    await waitFinished([containerId], auth.token, (s) => {
      const code = s[0]?.status_code ?? '';
      if (code !== last) log(`holat: ${code}`);
      last = code;
    });
    updatePost(postId, { status: 'publishing' });
    const mediaId = await publishContainer(auth.userId, containerId, auth.token);
    let permalink: string | undefined;
    try {
      permalink = (await getMedia(mediaId, auth.token)).permalink;
    } catch {
      /* published anyway */
    }
    updatePost(postId, { status: 'published', media_id: mediaId, permalink: permalink ?? null, error: null });
    log(`joylandi: ${permalink ?? mediaId}`);
    if (!opts.silent) await notifyPublished({ type: spec.type, label: spec.label, permalink, mediaId });
    return { postId, mediaId, permalink, resumed };
  } catch (err) {
    updatePost(postId, { status: 'failed', error: err instanceof GraphError ? err.describe() : (err as Error).message });
    throw err;
  }
}
