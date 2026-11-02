import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mockEnv, startMock, type Mock } from './mock-graph.ts';

const mock: Mock = await startMock();
mockEnv(mock, mkdtempSync(join(tmpdir(), 'ig-data-')));
process.env.IG_RETRY_BASE_MS = '10';

const { storeToken, loadToken, getAuth, loginWithCode } = await import('../src/api/auth.ts');
const { publish, DuplicateError, getPost, listPosts } = await import('../src/service.ts');
const { enqueue, runDue, getQueueItem } = await import('../src/queue.ts');
const { getDb, kvDelete, kvGet } = await import('../src/db.ts');
const { setQuiet } = await import('../src/log.ts');
const { makeVideo, makeImage } = await import('./fixtures.ts');

setQuiet(true);

const lastContainerParams = () => [...mock.state.containers.values()].at(-1)!.params;

describe('publish flow (mock Graph API)', () => {
  before(async () => {
    await storeToken('TEST_TOKEN');
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.state.resumableUnsupported = false;
    mock.state.failNextContainers = 0;
    mock.state.publishTransientFailures = 0;
    mock.state.quotaUsage = 0;
    kvDelete('resumable_broken_until');
  });

  it('stores a pasted token with account info', () => {
    const t = loadToken()!;
    assert.equal(t.username, 'test_biz');
    assert.equal(t.userId, '17841400000000001');
    assert.ok(t.expiresAt && Date.parse(t.expiresAt) > Date.now() + 59 * 86_400_000);
  });

  it('publishes a reel via resumable upload with a converted cover', async () => {
    const video = makeVideo('reel1.mp4', 4);
    const cover = makeImage('cover1.png', 1080, 1920);
    const res = await publish(
      { type: 'reel', media: [video], cover, caption: 'Salom #test', label: 'reel-1' },
      { silent: true },
    );
    assert.match(res.permalink!, /instagram\.com\/reel\//);
    const reel = [...mock.state.containers.values()].find((c) => c.params.media_type === 'REELS')!;
    assert.equal(reel.params.upload_type, 'resumable');
    assert.equal(reel.params.caption, 'Salom #test');
    assert.equal(reel.params.share_to_feed, 'true');
    assert.match(reel.params.cover_url, /^https:\/\/files\.example\.test\/.*cover1\.jpg$/);
    assert.equal(reel.uploadedBytes, statSync(video).size);
    const row = getPost(res.postId)!;
    assert.equal(row.status, 'published');
    assert.equal(row.media_id, res.mediaId);
  });

  it('refuses to publish the same media twice unless forced', async () => {
    const video = makeVideo('reel1.mp4', 4); // identical bytes to the previous test
    await assert.rejects(publish({ type: 'reel', media: [video] }, { silent: true }), DuplicateError);
    const forced = await publish({ type: 'reel', media: [video] }, { silent: true, force: true });
    assert.ok(forced.mediaId);
  });

  it('falls back to a public URL when resumable upload is unsupported, and remembers it', async () => {
    mock.state.resumableUnsupported = true;
    const res = await publish({ type: 'reel', media: [makeVideo('reel2.mp4', 5)] }, { silent: true });
    assert.ok(res.mediaId);
    assert.match(lastContainerParams().video_url, /reel2\.mp4$/);
    assert.ok((kvGet<number>('resumable_broken_until') ?? 0) > Date.now());

    const before = mock.state.calls.length;
    await publish({ type: 'reel', media: [makeVideo('reel3.mp4', 6)] }, { silent: true });
    const resumableTries = mock.state.calls.slice(before).filter((c) => c.params.upload_type === 'resumable');
    assert.equal(resumableTries.length, 0, 'second post should skip the resumable attempt');
  });

  it('publishes a mixed carousel', async () => {
    const res = await publish(
      {
        type: 'carousel',
        media: [makeImage('c1.jpg', 1080, 1350), makeImage('c2.png', 1080, 1080), makeVideo('c3.mp4', 3)],
        caption: 'Karusel',
        altText: 'tavsif',
      },
      { silent: true },
    );
    assert.ok(res.mediaId);
    const all = [...mock.state.containers.values()];
    const children = all.filter((c) => c.params.is_carousel_item === 'true');
    const parent = all.find((c) => c.params.media_type === 'CAROUSEL')!;
    assert.equal(parent.params.children.split(',').length, 3);
    assert.equal(parent.params.caption, 'Karusel');
    assert.ok(children.some((c) => c.params.media_type === 'VIDEO'));
    assert.ok(children.some((c) => /c2\.jpg$/.test(c.params.image_url ?? '')), 'png converted to jpg');
    assert.equal(children.find((c) => c.params.image_url)?.params.caption, undefined);
  });

  it('publishes an image story without caption', async () => {
    const res = await publish({ type: 'story', media: [makeImage('s1.jpg', 1080, 1920)] }, { silent: true });
    assert.ok(res.mediaId);
    assert.equal(lastContainerParams().media_type, 'STORIES');
  });

  it('marks the post failed when Instagram reports a container ERROR', async () => {
    mock.state.failNextContainers = 1;
    await assert.rejects(
      publish({ type: 'reel', media: [makeVideo('bad.mp4', 7)] }, { silent: true }),
      /ERROR/,
    );
    assert.equal(listPosts(1)[0].status, 'failed');
  });

  it('resumes a post whose container finished but was never published', async () => {
    const video = makeVideo('resume.mp4', 8);
    mock.state.publishTransientFailures = 10; // more than the retry budget
    await assert.rejects(publish({ type: 'reel', media: [video] }, { silent: true }));
    const failed = listPosts(1)[0];
    assert.equal(failed.status, 'failed');
    const containersBefore = mock.state.containers.size;

    mock.state.publishTransientFailures = 0;
    const res = await publish({ type: 'reel', media: [video] }, { silent: true });
    assert.equal(res.resumed, true);
    assert.equal(res.postId, failed.id);
    assert.equal(mock.state.containers.size, containersBefore, 'no new container created');
  });

  it('stops before uploading when the 24h quota is used up', async () => {
    mock.state.quotaUsage = 100;
    const before = mock.state.containers.size;
    await assert.rejects(publish({ type: 'reel', media: [makeVideo('quota.mp4', 9)] }, { silent: true }), /limit/);
    assert.equal(mock.state.containers.size, before);
  });

  it('queue: publishes due items and reschedules transient failures', async () => {
    const ok = enqueue({ type: 'reel', media: [makeVideo('q1.mp4', 10)], label: 'q1' }, new Date(Date.now() - 1000));
    const later = enqueue({ type: 'reel', media: [makeVideo('q2.mp4', 11)] }, new Date(Date.now() + 3_600_000));
    let s = await runDue();
    assert.deepEqual(s, { processed: 1, published: 1, failed: 0, retrying: 0 });
    assert.equal(getQueueItem(ok.id)!.status, 'done');
    assert.equal(getQueueItem(later.id)!.status, 'pending');

    mock.state.quotaUsage = 100; // rate limit -> retry in an hour
    const rl = enqueue({ type: 'reel', media: [makeVideo('q3.mp4', 12)] }, new Date(Date.now() - 1000));
    s = await runDue();
    assert.equal(s.retrying, 1);
    const item = getQueueItem(rl.id)!;
    assert.equal(item.status, 'pending');
    assert.ok(Date.parse(item.run_at.replace(' ', 'T') + 'Z') > Date.now() + 50 * 60_000);
    assert.match(item.last_error!, /limit/);
  });

  it('queue: a missing file is a permanent failure', async () => {
    const v = makeVideo('gone.mp4', 13);
    const item = enqueue({ type: 'reel', media: [v] }, new Date(Date.now() - 1000));
    (await import('node:fs')).rmSync(v);
    const s = await runDue();
    assert.equal(s.failed, 1);
    assert.equal(getQueueItem(item.id)!.status, 'failed');
  });

  it('refreshes an old token automatically', async () => {
    const t = loadToken()!;
    getDb()
      .prepare(`UPDATE kv SET value = ? WHERE key = 'token'`)
      .run(JSON.stringify({ ...t, issuedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString() }));
    const auth = await getAuth();
    assert.match(auth.token, /^REFRESHED_/);
    assert.ok(Date.parse(loadToken()!.expiresAt!) > Date.now() + 59 * 86_400_000);
  });

  it('OAuth login: code (with #_ suffix) -> long-lived token', async () => {
    const t = await loginWithCode('https://localhost/?code=GOODCODE#_');
    assert.equal(t.accessToken, 'LONG_TOKEN');
    assert.equal(t.username, 'test_biz');
  });
});
