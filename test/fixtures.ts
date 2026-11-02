import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.ts';

export const fixtureDir = mkdtempSync(join(tmpdir(), 'ig-fixtures-'));

/** A compliant 9:16 H.264/AAC clip; `seconds` doubles as a way to get distinct fingerprints. */
export function makeVideo(name: string, seconds: number, opts: { fps?: number; faststart?: boolean } = {}): string {
  const out = join(fixtureDir, name);
  execFileSync(config.ffmpeg, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `nullsrc=s=1080x1920:r=${opts.fps ?? 30}:d=${seconds}`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', String(seconds), '-vf', 'format=yuv420p', '-c:v', 'libx264', '-c:a', 'aac',
    ...(opts.faststart === false ? [] : ['-movflags', '+faststart']),
    out,
  ]);
  return out;
}

export function makeImage(name: string, w: number, h: number): string {
  const out = join(fixtureDir, name);
  const fmt = name.endsWith('.png') ? 'rgb24' : 'yuvj420p';
  execFileSync(config.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `nullsrc=s=${w}x${h}`, '-frames:v', '1', '-vf', `format=${fmt}`, out]);
  return out;
}
