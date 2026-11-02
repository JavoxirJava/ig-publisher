import { request } from './http.ts';

const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url';

// By IG user id, not `me`: with Facebook Login `me` is the Page, not the Instagram account.
export async function listMedia(userId: string, token: string, limit = 10, after?: string) {
  return request<{ data: any[]; paging?: { cursors?: { after?: string } } }>(`${userId}/media`, {
    token,
    params: { fields: MEDIA_FIELDS, limit, after },
  });
}

export const DEFAULT_METRICS = {
  REELS: 'views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time',
  FEED: 'views,reach,likes,comments,shares,saved,total_interactions',
  STORY: 'views,reach,replies,shares,total_interactions,navigation',
} as const;

export async function mediaInsights(mediaId: string, token: string, metrics?: string) {
  let metric = metrics;
  if (!metric) {
    const m = await request<{ media_product_type?: keyof typeof DEFAULT_METRICS }>(mediaId, {
      token,
      params: { fields: 'media_product_type' },
    });
    metric = DEFAULT_METRICS[m.media_product_type ?? 'FEED'] ?? DEFAULT_METRICS.FEED;
  }
  const res = await request<{ data: { name: string; values?: { value: unknown }[]; total_value?: { value: unknown } }[] }>(
    `${mediaId}/insights`,
    { token, params: { metric } },
  );
  const out: Record<string, unknown> = {};
  for (const d of res.data ?? []) out[d.name] = d.total_value?.value ?? d.values?.[0]?.value;
  return out;
}

export async function accountInsights(userId: string, token: string, metrics = 'reach,views,accounts_engaged,total_interactions', period = 'day') {
  const res = await request<{ data: any[] }>(`${userId}/insights`, {
    token,
    params: { metric: metrics, period, metric_type: 'total_value' },
  });
  const out: Record<string, unknown> = {};
  for (const d of res.data ?? []) out[d.name] = d.total_value?.value ?? d.values?.at(-1)?.value;
  return out;
}

export async function listComments(mediaId: string, token: string, limit = 50) {
  const res = await request<{ data: any[] }>(`${mediaId}/comments`, {
    token,
    params: {
      fields: 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp}',
      limit,
    },
  });
  return res.data ?? [];
}

export async function replyToComment(commentId: string, message: string, token: string) {
  return request<{ id: string }>(`${commentId}/replies`, { method: 'POST', token, params: { message }, retries: 0 });
}

export async function setCommentHidden(commentId: string, hide: boolean, token: string) {
  return request<{ success: boolean }>(commentId, { method: 'POST', token, params: { hide }, retries: 1 });
}

export async function deleteComment(commentId: string, token: string) {
  return request<{ success: boolean }>(commentId, { method: 'DELETE', token, retries: 1 });
}
