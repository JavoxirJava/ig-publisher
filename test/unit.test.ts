import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.IG_ENV_FILE = '/nonexistent';
process.env.IG_DATA_DIR = mkdtempSync(join(tmpdir(), 'ig-unit-'));

const { parseWhen } = await import('../src/queue.ts');
const { normalizeSpec, SpecError } = await import('../src/spec.ts');
const { check, isFaststart } = await import('../src/media/probe.ts');
const { extractCode } = await import('../src/api/auth.ts');
const { redact } = await import('../src/log.ts');
const { makeVideo, makeImage } = await import('./fixtures.ts');

describe('parseWhen', () => {
  const now = new Date(2026, 9, 26, 21, 30, 0);
  it('relative', () => {
    assert.equal(parseWhen('+2h', now).getTime(), now.getTime() + 7_200_000);
    assert.equal(parseWhen('+30m', now).getTime(), now.getTime() + 1_800_000);
    assert.equal(parseWhen('+1d', now).getTime(), now.getTime() + 86_400_000);
  });
  it('clock time rolls to tomorrow when passed', () => {
    assert.deepEqual(parseWhen('09:00', now), new Date(2026, 9, 27, 9, 0));
    assert.deepEqual(parseWhen('22:15', now), new Date(2026, 9, 26, 22, 15));
    assert.deepEqual(parseWhen('ertaga 09:00', now), new Date(2026, 9, 27, 9, 0));
  });
  it('absolute local', () => {
    assert.deepEqual(parseWhen('2026-11-01 18:30', now), new Date(2026, 10, 1, 18, 30));
  });
  it('rejects nonsense', () => {
    assert.throws(() => parseWhen('qachondir', now));
  });
});

describe('normalizeSpec', () => {
  const video = makeVideo('u1.mp4', 3);
  const img = makeImage('u1.jpg', 1080, 1350);
  it('accepts a valid reel', () => {
    const s = normalizeSpec({ type: 'reel', media: [video], caption: 'ok' });
    assert.equal(s.media[0], video);
  });
  it('enforces Instagram limits', () => {
    assert.throws(() => normalizeSpec({ type: 'reel', media: [video, video] }), SpecError);
    assert.throws(() => normalizeSpec({ type: 'carousel', media: [img] }), /2–20/);
    assert.throws(() => normalizeSpec({ type: 'reel', media: [video], caption: 'x'.repeat(2201) }), /2200/);
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    assert.throws(() => normalizeSpec({ type: 'reel', media: [video], caption: tags }), /hashtag/);
    assert.throws(() => normalizeSpec({ type: 'story', media: [img], caption: 'x' }), /story/);
    assert.throws(() => normalizeSpec({ type: 'image', media: [img], cover: img }), /cover/);
    assert.throws(() => normalizeSpec({ type: 'reel', media: ['/no/such.mp4'] }), /topilmadi/);
    assert.throws(() => normalizeSpec({ type: 'reel', media: [video], collaborators: ['a', 'b', 'c', 'd'] }), /3/);
  });
  it('allows remote URLs without touching disk', () => {
    const s = normalizeSpec({ type: 'image', media: ['https://example.com/a.jpg'] });
    assert.equal(s.media[0], 'https://example.com/a.jpg');
  });
});

describe('media checks', () => {
  it('detects moov position', () => {
    assert.equal(isFaststart(makeVideo('fs.mp4', 3)), true);
    assert.equal(isFaststart(makeVideo('nofs.mp4', 3, { faststart: false })), false);
  });
  it('flags fixable video issues', async () => {
    const c = await check(makeVideo('slow.mp4', 3, { fps: 15, faststart: false }), 'reel');
    assert.equal(c.errors.length, 0);
    assert.ok(c.fixable.some((f) => f.startsWith('fps')));
    assert.ok(c.fixable.some((f) => f.startsWith('moov')));
  });
  it('rejects bad feed aspect ratio and short video', async () => {
    assert.ok((await check(makeImage('tall.jpg', 1080, 1920), 'feed')).errors.length);
    assert.equal((await check(makeImage('tall.jpg', 1080, 1920), 'story')).errors.length, 0);
    assert.ok((await check(makeVideo('short.mp4', 2), 'reel')).errors.some((e) => /qisqa/.test(e)));
  });
});

describe('helpers', () => {
  it('extracts OAuth code from redirect URL', () => {
    assert.equal(extractCode('https://localhost/?code=AbC123#_'), 'AbC123');
    assert.equal(extractCode('AbC123#_'), 'AbC123');
  });
  it('redacts secrets', () => {
    assert.equal(redact('x?access_token=IGQVJ123&y=1'), 'x?access_token=***&y=1');
    assert.equal(redact('Authorization: OAuth IGAAabcdefghijklmnopqrstuvwxyz0123'), 'Authorization: OAuth ***');
  });
});
