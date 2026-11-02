import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { mockEnv, startMock, type Mock } from './mock-graph.ts';

const mock: Mock = await startMock();
mockEnv(mock, mkdtempSync(join(tmpdir(), 'ig-data-')));
process.env.IG_LOGIN = 'facebook';
process.env.IG_RETRY_BASE_MS = '10';

const { storeToken, loadToken, getAuth, refreshIfNeeded, authorizeUrl } = await import('../src/api/auth.ts');
const { listMedia } = await import('../src/api/media.ts');
const { publish } = await import('../src/service.ts');
const { setQuiet } = await import('../src/log.ts');
const { makeVideo } = await import('./fixtures.ts');

setQuiet(true);

describe('Facebook Login mode (mock Graph API)', () => {
  after(() => mock.close());

  it('exchanges the user token and stores the Page token of the Page with Instagram linked', async () => {
    const t = await storeToken('FB_USER_TOKEN');
    assert.equal(t.accessToken, 'FB_PAGE_TOKEN');
    assert.equal(t.pageId, '501');
    assert.equal(t.userId, '17841400000000002');
    assert.equal(t.username, 'test_fb');
    assert.equal(t.expiresAt, undefined);
    assert.deepEqual(loadToken(), t);
  });

  it('never refreshes the Page token and has no OAuth URL', async () => {
    assert.equal(await refreshIfNeeded(true), false);
    assert.throws(() => authorizeUrl(), /ig auth token/);
  });

  it('lists media and publishes a reel by IG user id', async () => {
    const { token, userId } = await getAuth();
    const video = makeVideo('fb-reel.mp4', 4);
    const res = await publish({ type: 'reel', media: [video], caption: 'fb' }, { silent: true });
    assert.ok(res.mediaId);
    const created = mock.state.calls.find((c) => c.method === 'POST' && c.path.endsWith(`/${userId}/media`));
    assert.equal(created?.params.access_token, token);
    const media = await listMedia(userId, token);
    assert.equal(media.data[0].id, res.mediaId);
  });

  it('picks the Page by its Instagram username (IG_USERNAME) when one token covers several', async () => {
    const { config } = await import('../src/config.ts');
    config.username = 'second_ig';
    try {
      const t = await storeToken('FB_USER_TOKEN');
      assert.equal(t.pageId, '502');
      assert.equal(t.username, 'second_ig');
      config.username = 'missing';
      await assert.rejects(storeToken('FB_USER_TOKEN'), /@missing.*@second_ig/);
    } finally {
      config.username = '';
    }
  });
});
