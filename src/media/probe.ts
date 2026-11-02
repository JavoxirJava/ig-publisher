import { execFile } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import { log } from '../log.ts';

const run = promisify(execFile);

export type MediaKind = 'video' | 'image';
export type Target = 'reel' | 'story' | 'feed' | 'carousel' | 'cover';

export interface Probe {
  kind: MediaKind;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioSampleRate?: number;
  pixFmt?: string;
  formatName?: string;
  faststart?: boolean;
}

export interface Check {
  probe: Probe;
  errors: string[];
  /** Problems ffmpeg can fix automatically. */
  fixable: string[];
  warnings: string[];
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.bmp', '.gif']);
const MB = 1024 * 1024;

export function kindOf(path: string): MediaKind {
  const ext = extname(path.split('?')[0]).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  throw new Error(`noma’lum fayl turi: ${path}`);
}

/** Walks the top-level MP4 boxes: Instagram wants `moov` before `mdat`. */
export function isFaststart(path: string): boolean | undefined {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const header = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= size) {
      readSync(fd, header, 0, 16, pos);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) return undefined;
      if (boxSize < 8) return undefined;
      pos += boxSize;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function needFfprobe(): string {
  if (!config.ffprobe) throw new Error('ffprobe topilmadi: FFPROBE_PATH ni .env da ko‘rsating');
  return config.ffprobe;
}

function needFfmpeg(): string {
  if (!config.ffmpeg) throw new Error('ffmpeg topilmadi: FFMPEG_PATH ni .env da ko‘rsating');
  return config.ffmpeg;
}

export async function probe(path: string): Promise<Probe> {
  const kind = kindOf(path);
  const sizeBytes = statSync(path).size;
  const { stdout } = await run(needFfprobe(), [
    '-v', 'error', '-of', 'json',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,pix_fmt,sample_rate',
    '-show_entries', 'format=duration,format_name',
    path,
  ]);
  const info = JSON.parse(stdout);
  const v = info.streams?.find((s: any) => s.codec_type === 'video');
  const a = info.streams?.find((s: any) => s.codec_type === 'audio');
  const rate = (r?: string) => {
    if (!r) return undefined;
    const [n, d] = r.split('/').map(Number);
    return d ? n / d : n;
  };
  const p: Probe = {
    kind,
    sizeBytes,
    width: v?.width,
    height: v?.height,
    pixFmt: v?.pix_fmt,
    formatName: info.format?.format_name,
  };
  if (kind === 'video') {
    p.durationSec = Number(info.format?.duration) || undefined;
    p.fps = rate(v?.avg_frame_rate) || rate(v?.r_frame_rate);
    p.videoCodec = v?.codec_name;
    p.audioCodec = a?.codec_name;
    p.audioSampleRate = a?.sample_rate ? Number(a.sample_rate) : undefined;
    p.faststart = /mp4|mov/.test(p.formatName ?? '') ? isFaststart(path) : undefined;
  } else {
    p.videoCodec = v?.codec_name; // mjpeg / png / webp
  }
  return p;
}

export async function check(path: string, target: Target): Promise<Check> {
  const p = await probe(path);
  const errors: string[] = [];
  const fixable: string[] = [];
  const warnings: string[] = [];

  if (p.kind === 'video') {
    if (target === 'feed' || target === 'cover') errors.push('bu joyga video emas, rasm kerak');
    const maxDur = target === 'story' ? 60 : 900;
    const maxSize = target === 'story' ? 100 * MB : 300 * MB;
    if (p.durationSec !== undefined && p.durationSec < 3) errors.push(`video juda qisqa (${p.durationSec.toFixed(1)}s < 3s)`);
    if (p.durationSec !== undefined && p.durationSec > maxDur) errors.push(`video juda uzun (${p.durationSec.toFixed(0)}s > ${maxDur}s)`);
    if (!/mp4|mov/.test(p.formatName ?? '')) fixable.push(`konteyner ${p.formatName} → MP4`);
    if (!['h264', 'hevc'].includes(p.videoCodec ?? '')) fixable.push(`video kodek ${p.videoCodec} → H.264`);
    if (p.pixFmt && !/420p/.test(p.pixFmt)) fixable.push(`pixel format ${p.pixFmt} → yuv420p`);
    if (!p.audioCodec) warnings.push('audio yo‘q');
    else if (p.audioCodec !== 'aac') fixable.push(`audio kodek ${p.audioCodec} → AAC`);
    if (p.audioSampleRate && p.audioSampleRate > 48_000) fixable.push(`audio ${p.audioSampleRate}Hz → 48kHz`);
    if (p.fps !== undefined && (p.fps < 23 || p.fps > 60)) fixable.push(`fps ${p.fps.toFixed(2)} → 30`);
    if (p.width && p.width > 1920) fixable.push(`kenglik ${p.width}px → 1920px gacha`);
    if (p.faststart === false) fixable.push('moov atom fayl oxirida → faststart');
    if (p.sizeBytes > maxSize) fixable.push(`hajm ${(p.sizeBytes / MB).toFixed(0)}MB > ${maxSize / MB}MB → qayta siqish`);
    if (p.width && p.height && Math.abs(p.width / p.height - 9 / 16) > 0.02 && target !== 'carousel') {
      warnings.push(`nisbat ${p.width}x${p.height}, tavsiya 9:16 (1080x1920)`);
    }
  } else {
    if (target === 'reel') errors.push('reel uchun video kerak');
    if (p.videoCodec !== 'mjpeg' || !/\.jpe?g$/i.test(path)) fixable.push(`${extname(path)} → JPEG`);
    if (p.sizeBytes > 8 * MB) fixable.push(`rasm ${(p.sizeBytes / MB).toFixed(1)}MB > 8MB → siqish`);
    if (p.width && p.width > 1440 && target !== 'story' && target !== 'cover') {
      warnings.push(`kenglik ${p.width}px, Instagram 1440px ga kichraytiradi`);
    }
    if ((target === 'feed' || target === 'carousel') && p.width && p.height) {
      const r = p.width / p.height;
      if (r < 0.8 - 0.005 || r > 1.91 + 0.005) {
        errors.push(`feed rasm nisbati ${r.toFixed(3)} — 4:5 (0.8) dan 1.91:1 gacha bo‘lishi kerak`);
      }
    }
  }
  return { probe: p, errors, fixable, warnings };
}

let workDir: string | undefined;
function tmp(name: string): string {
  workDir ??= mkdtempSync(join(tmpdir(), 'ig-publisher-'));
  return join(workDir, name);
}

/** Produces an Instagram-compliant copy when `check` found fixable issues; returns the original path otherwise. */
export async function prepare(path: string, target: Target, allowFix = true): Promise<{ path: string; check: Check }> {
  const c = await check(path, target);
  if (c.errors.length) throw new Error(`${basename(path)}: ${c.errors.join('; ')}`);
  for (const w of c.warnings) log(`${basename(path)}: ogohlantirish — ${w}`);
  if (!c.fixable.length) return { path, check: c };
  if (!allowFix) throw new Error(`${basename(path)}: ${c.fixable.join('; ')} (avto-tuzatish o‘chirilgan)`);
  log(`${basename(path)}: tuzatilmoqda — ${c.fixable.join('; ')}`);

  const ffmpeg = needFfmpeg();
  const stem = basename(path, extname(path));
  if (c.probe.kind === 'image') {
    const out = tmp(`${stem}.jpg`);
    const maxW = target === 'story' || target === 'cover' ? 1080 : 1440;
    const hasAlpha = /^(rgba|bgra|argb|abgr|ya8|ya16|yuva|gbrap|pal8)/.test(c.probe.pixFmt ?? '');
    const scale = `scale='min(${maxW},iw)':-2,format=yuvj420p`;
    // Flatten transparency onto white when ffmpeg has the filters (Remotion's minimal build doesn't).
    const flatten = `color=c=white:s=${c.probe.width}x${c.probe.height}[bg];[bg][0:v]overlay=shortest=1,${scale}`;
    let filters = hasAlpha ? ['-filter_complex', flatten] : ['-vf', scale];
    let q = 2;
    for (;;) {
      try {
        await run(ffmpeg, ['-y', '-v', 'error', '-i', path, ...filters, '-frames:v', '1', '-q:v', String(q), out]);
      } catch (err) {
        if (filters[0] !== '-filter_complex') throw err;
        log(`${basename(path)}: shaffof fon oq rangga aylantirilmadi (ffmpeg’da overlay yo‘q) — shaffof joylar qora chiqishi mumkin`);
        filters = ['-vf', scale];
        continue;
      }
      if (statSync(out).size <= 8 * MB || q >= 10) break;
      q += 2;
    }
    return { path: out, check: await check(out, target) };
  }

  const p = c.probe;
  const copyOnly = c.fixable.every((f) => f.startsWith('moov') || f.startsWith('konteyner'))
    && ['h264', 'hevc'].includes(p.videoCodec ?? '') && (!p.audioCodec || p.audioCodec === 'aac');
  const out = tmp(`${stem}.mp4`);
  const args = ['-y', '-v', 'error', '-i', path];
  if (copyOnly) {
    args.push('-c', 'copy');
  } else {
    const maxSize = target === 'story' ? 100 * MB : 300 * MB;
    const vBitrate = p.durationSec ? Math.min(20_000, Math.floor((maxSize * 8 * 0.9) / p.durationSec / 1000) - 160) : 8000;
    const fps = p.fps !== undefined && (p.fps < 23 || p.fps > 60) ? ['-r', '30'] : [];
    args.push(
      '-vf', "scale='min(1920,iw)':-2,format=yuv420p",
      ...fps,
      '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high',
      '-maxrate', `${vBitrate}k`, '-bufsize', `${vBitrate * 2}k`, '-crf', '20',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', // closed, regular GOPs
      '-c:a', 'aac', '-ar', '48000', '-b:a', '128k',
    );
  }
  args.push('-movflags', '+faststart', out);
  await run(ffmpeg, args, { maxBuffer: 16 * MB });
  const after = await check(out, target);
  if (after.errors.length || after.fixable.length) {
    throw new Error(`${basename(path)}: tuzatishdan keyin ham muammo: ${[...after.errors, ...after.fixable].join('; ')}`);
  }
  return { path: out, check: after };
}

/** Removes ffmpeg outputs of this process (after they were uploaded). */
export function cleanupTemp(): void {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
}
