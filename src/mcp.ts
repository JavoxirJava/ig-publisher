// MCP server (stdio) exposing ig-publisher to any MCP client: Claude Code/Desktop, local-LLM clients, etc.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchMe, getAuth, loadToken, tokenDaysLeft } from './api/auth.ts';
import { GraphError } from './api/http.ts';
import { accountInsights, listComments, listMedia, mediaInsights, replyToComment } from './api/media.ts';
import { publishingLimit } from './api/publish.ts';
import { check, type Target } from './media/probe.ts';
import { cancelQueueItem, enqueue, listQueue, rescheduleQueueItem } from './queue.ts';
import { schedulerStatus } from './scheduler.ts';
import { listPosts, publish } from './service.ts';
import { loadSpecFile, POST_TYPES, type PostSpec } from './spec.ts';

const server = new McpServer({ name: 'ig-publisher', version: '1.0.0' });

const specShape = {
  type: z.enum(POST_TYPES as [string, ...string[]]).optional().describe('reel | image | carousel | story (specFile bo‘lmasa majburiy)'),
  media: z.array(z.string()).optional().describe('Absolute local paths or public https URLs. reel/image/story: 1, carousel: 2-20'),
  specFile: z.string().optional().describe('Path to a post JSON spec instead of the fields below'),
  caption: z.string().optional(),
  captionFile: z.string().optional(),
  cover: z.string().optional().describe('Reel cover image (png/jpg, converted automatically)'),
  thumbOffsetMs: z.number().optional(),
  shareToFeed: z.boolean().optional().describe('Reel also in main feed (default true)'),
  collaborators: z.array(z.string()).optional(),
  locationId: z.string().optional(),
  userTags: z.array(z.object({ username: z.string(), x: z.number().optional(), y: z.number().optional() })).optional(),
  altText: z.string().optional(),
  audioName: z.string().optional(),
  aiGenerated: z.boolean().optional(),
  trial: z.enum(['MANUAL', 'SS_PERFORMANCE']).optional(),
  fix: z.boolean().optional().describe('Auto-fix media with ffmpeg (default true)'),
  label: z.string().optional().describe('Name shown in history/notifications, e.g. my-series-002'),
};

type SpecArgs = { [K in keyof typeof specShape]?: unknown };

function toSpec(args: SpecArgs): PostSpec {
  const { specFile, ...rest } = args as Record<string, unknown>;
  if (specFile) {
    const spec = loadSpecFile(String(specFile));
    return rest.label ? { ...spec, label: String(rest.label) } : spec;
  }
  if (!rest.type || !rest.media) throw new Error('type va media (yoki specFile) kerak');
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return clean as unknown as PostSpec;
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const msg = err instanceof GraphError ? err.describe() : (err as Error).message;
  return { content: [{ type: 'text' as const, text: `Xato: ${msg}` }], isError: true };
}

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: any) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  }) as any);
}

tool('ig_account', 'Connected Instagram account, token expiry, 24h publishing quota and scheduler status.', {}, async () => {
  const t = loadToken();
  if (!t) return { connected: false, hint: 'Run `ig auth token <TOKEN>` (see ~/ig-publisher/SETUP.md)' };
  const me = await fetchMe(t.accessToken);
  const { token, userId } = await getAuth();
  const quota = await publishingLimit(userId, token).catch((e) => ({ error: (e as Error).message }));
  return { connected: true, me, tokenDaysLeft: tokenDaysLeft(t), quota, scheduler: schedulerStatus() };
});

tool(
  'ig_check_media',
  'Validate a local media file against Instagram specs (reel/story/feed/carousel/cover). Lists errors, auto-fixable issues and warnings.',
  { path: z.string(), as: z.enum(['reel', 'story', 'feed', 'carousel', 'cover']).optional() },
  async ({ path, as }) => check(path, (as ?? (/\.(mp4|mov|m4v|webm|mkv)$/i.test(path) ? 'reel' : 'feed')) as Target),
);

tool(
  'ig_publish',
  'Publish to Instagram NOW (blocks until Instagram finishes processing, typically 1-5 min for a reel). ' +
    'Use dryRun:true first to validate without posting. Refuses media that was already published unless force:true.',
  { ...specShape, dryRun: z.boolean().optional(), force: z.boolean().optional() },
  async (args) => {
    const { dryRun, force, ...rest } = args;
    return publish(toSpec(rest), { dryRun, force });
  },
);

tool(
  'ig_schedule',
  'Queue a post for later. `when`: "+2h", "09:00", "ertaga 09:00", "2026-10-27 18:30" (local time) or "now". ' +
    'Published by the systemd timer (`ig scheduler install`).',
  { ...specShape, when: z.string() },
  async (args) => {
    const { when, ...rest } = args;
    const item = enqueue(toSpec(rest), when);
    return { queued: item, scheduler: schedulerStatus() };
  },
);

tool('ig_queue_list', 'List pending/running queue items (all:true for full history).', { all: z.boolean().optional() }, async ({ all }) =>
  listQueue(all).map((r) => ({ ...r, spec: JSON.parse(r.spec) })),
);

tool('ig_queue_cancel', 'Cancel a pending queue item.', { id: z.number() }, async ({ id }) => {
  if (!cancelQueueItem(id)) throw new Error(`#${id} pending emas`);
  return { cancelled: id };
});

tool('ig_queue_retry', 'Re-schedule a failed/cancelled/pending queue item.', { id: z.number(), when: z.string().optional() }, async ({ id, when }) =>
  rescheduleQueueItem(id, when ?? 'now'),
);

tool('ig_history', 'Recent publish attempts with status and permalink.', { limit: z.number().optional(), status: z.string().optional() }, async ({ limit, status }) =>
  listPosts(limit ?? 20, status).map((r) => ({ ...r, spec: JSON.parse(r.spec) })),
);

tool('ig_media_list', 'Recent posts on the account with like/comment counts.', { limit: z.number().optional() }, async ({ limit }) => {
  const { token, userId } = await getAuth();
  return (await listMedia(userId, token, limit ?? 10)).data;
});

tool(
  'ig_insights',
  'Insights for a media id (views, reach, likes, shares, saves, watch time...) or "account". Needs instagram_business_manage_insights.',
  { target: z.string().describe('media id or "account"'), metrics: z.string().optional() },
  async ({ target, metrics }) => {
    const { token, userId } = await getAuth();
    return target === 'account' ? accountInsights(userId, token, metrics) : mediaInsights(target, token, metrics);
  },
);

tool('ig_comments', 'Comments (with replies) on a media id.', { mediaId: z.string() }, async ({ mediaId }) => {
  const { token } = await getAuth();
  return listComments(mediaId, token);
});

tool('ig_reply', 'Reply to a comment. Posts publicly — confirm the text with the user first.', { commentId: z.string(), message: z.string() }, async ({ commentId, message }) => {
  const { token } = await getAuth();
  return replyToComment(commentId, message, token);
});

await server.connect(new StdioServerTransport());
