import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isRemote } from './host/index.ts';

export type PostType = 'reel' | 'image' | 'carousel' | 'story';
export const POST_TYPES: PostType[] = ['reel', 'image', 'carousel', 'story'];

export interface UserTag {
  username: string;
  x?: number;
  y?: number;
}

/** One post, as accepted by the CLI (--spec file), the queue and the MCP server. */
export interface PostSpec {
  type: PostType;
  /** Local paths or public https URLs. reel/image/story: exactly 1; carousel: 2–20. */
  media: string[];
  caption?: string;
  /** Read into `caption` when `caption` is not set. Relative to the spec file / cwd. */
  captionFile?: string;
  /** Reel cover image (local or URL). */
  cover?: string;
  /** Reel/video frame used as thumbnail when there is no cover, in ms. */
  thumbOffsetMs?: number;
  /** Reel also appears in the main feed grid (default true). */
  shareToFeed?: boolean;
  collaborators?: string[];
  locationId?: string;
  userTags?: UserTag[];
  altText?: string;
  audioName?: string;
  aiGenerated?: boolean;
  /** Trial reel: shown to non-followers first. */
  trial?: 'MANUAL' | 'SS_PERFORMANCE';
  /** Let ffmpeg fix non-compliant media (default true). */
  fix?: boolean;
  /** Free-form label for history, e.g. "my-series-002". */
  label?: string;
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

/** Resolves paths, loads captionFile and validates Instagram limits. Returns a new, self-contained spec. */
export function normalizeSpec(input: PostSpec, baseDir = process.cwd()): PostSpec {
  const spec: PostSpec = { ...input, media: [...(input.media ?? [])] };
  if (!POST_TYPES.includes(spec.type)) throw new SpecError(`type ${POST_TYPES.join('|')} bo‘lishi kerak`);
  const abs = (p: string) => (isRemote(p) || isAbsolute(p) ? p : resolve(baseDir, p));
  spec.media = spec.media.map(abs);
  if (spec.cover) spec.cover = abs(spec.cover);

  if (spec.caption === undefined && spec.captionFile) {
    const file = abs(spec.captionFile);
    if (!existsSync(file)) throw new SpecError(`captionFile topilmadi: ${file}`);
    spec.caption = readFileSync(file, 'utf8').trim();
  }
  delete spec.captionFile;

  const n = spec.media.length;
  if (spec.type === 'carousel') {
    if (n < 2 || n > 20) throw new SpecError(`karusel 2–20 ta media bo‘lishi kerak (hozir ${n})`);
  } else if (n !== 1) {
    throw new SpecError(`${spec.type} uchun aynan 1 ta media kerak (hozir ${n})`);
  }
  for (const m of [...spec.media, ...(spec.cover ? [spec.cover] : [])]) {
    if (!isRemote(m) && !existsSync(m)) throw new SpecError(`fayl topilmadi: ${m}`);
  }

  const caption = spec.caption ?? '';
  if (spec.type === 'story' && caption) throw new SpecError('story caption qo‘llab-quvvatlamaydi');
  if ([...caption].length > 2200) throw new SpecError(`caption ${[...caption].length} belgi > 2200`);
  const hashtags = caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (hashtags > 30) throw new SpecError(`caption’da ${hashtags} ta hashtag > 30`);
  const mentions = caption.match(/(^|\s)@[A-Za-z0-9._]+/g)?.length ?? 0;
  if (mentions > 20) throw new SpecError(`caption’da ${mentions} ta @mention > 20`);

  if (spec.cover && spec.type !== 'reel') throw new SpecError('cover faqat reel uchun');
  if (spec.collaborators && spec.collaborators.length > 3) throw new SpecError('collaborators ko‘pi bilan 3 ta');
  if (spec.collaborators?.length && spec.type === 'story') throw new SpecError('story collaborators qo‘llamaydi');
  if (spec.altText && spec.type !== 'image' && spec.type !== 'carousel') throw new SpecError('altText faqat rasm postlari uchun');
  if (spec.altText && [...spec.altText].length > 1000) throw new SpecError('altText ko‘pi bilan 1000 belgi');
  if (spec.audioName && spec.type !== 'reel') throw new SpecError('audioName faqat reel uchun');
  if (spec.trial && spec.type !== 'reel') throw new SpecError('trial faqat reel uchun');
  for (const t of spec.userTags ?? []) {
    if (!t.username) throw new SpecError('userTags: username kerak');
    for (const v of [t.x, t.y]) if (v !== undefined && (v < 0 || v > 1)) throw new SpecError('userTags x/y 0..1 oralig‘ida');
  }
  return spec;
}

export function loadSpecFile(path: string): PostSpec {
  const file = resolve(path);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as PostSpec;
  return normalizeSpec(raw, dirname(file));
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Identity of a post's content (type + media bytes), independent of caption, used to block double posting. */
export async function fingerprint(spec: PostSpec): Promise<string> {
  const h = createHash('sha256').update(spec.type);
  for (const m of spec.media) h.update('|').update(isRemote(m) ? m : await hashFile(m));
  return h.digest('hex').slice(0, 32);
}
