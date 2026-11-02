import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { config } from '../config.ts';
import { log } from '../log.ts';
import { GraphError, request, type Params } from './http.ts';

export type StatusCode = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

export interface Container {
  id: string;
  /** Returned for upload_type=resumable. */
  uri?: string;
}

export async function createContainer(userId: string, token: string, params: Params): Promise<Container> {
  // Not retried automatically: a timeout after Meta accepted the call would create a duplicate container.
  return request<Container>(`${userId}/media`, { method: 'POST', token, params, retries: 1 });
}

export async function uploadToContainer(container: Container, token: string, filePath: string): Promise<void> {
  const url = container.uri ?? `${config.ruploadBase}/ig-api-upload/${config.apiVersion}/${container.id}`;
  const size = statSync(filePath).size;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await request<{ success?: boolean; message?: string }>('', {
        method: 'POST',
        url,
        retries: 0,
        headers: {
          Authorization: `OAuth ${token}`,
          offset: '0',
          file_size: String(size),
          'Content-Type': 'application/octet-stream',
        },
        body: Readable.toWeb(createReadStream(filePath)) as ReadableStream,
      });
      if (res.success === false) throw new GraphError(res.message ?? 'upload failed', 200, { error: { message: res.message } });
      return;
    } catch (err) {
      const e = err as GraphError;
      if (attempt >= 3 || !(e.transient || e.isRateLimit)) throw err;
      log(`yuklash xatosi (${e.message}), qayta urinish ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
}

export interface ContainerStatus {
  id: string;
  status_code: StatusCode;
  status?: string;
}

export async function getStatus(containerId: string, token: string): Promise<ContainerStatus> {
  return request<ContainerStatus>(containerId, { token, params: { fields: 'id,status_code,status' } });
}

/** Polls until every container is FINISHED; throws on ERROR/EXPIRED or timeout. */
export async function waitFinished(ids: string[], token: string, onTick?: (s: ContainerStatus[]) => void): Promise<void> {
  const deadline = Date.now() + config.pollTimeoutMs;
  const pending = new Set(ids);
  while (pending.size) {
    const statuses = await Promise.all([...pending].map((id) => getStatus(id, token)));
    onTick?.(statuses);
    for (const s of statuses) {
      if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') pending.delete(s.id);
      else if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
        throw new Error(`container ${s.id}: ${s.status_code}${s.status ? ` — ${s.status}` : ''}`);
      }
    }
    if (!pending.size) return;
    if (Date.now() > deadline) throw new Error(`container(lar) ${[...pending].join(',')} vaqtida tayyor bo‘lmadi`);
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

export async function publishContainer(userId: string, creationId: string, token: string): Promise<string> {
  const res = await request<{ id: string }>(`${userId}/media_publish`, {
    method: 'POST',
    token,
    params: { creation_id: creationId },
    retries: 2,
  });
  return res.id;
}

export interface MediaInfo {
  id: string;
  permalink?: string;
  media_type?: string;
  media_product_type?: string;
  shortcode?: string;
  timestamp?: string;
  caption?: string;
}

export async function getMedia(mediaId: string, token: string): Promise<MediaInfo> {
  return request<MediaInfo>(mediaId, {
    token,
    params: { fields: 'id,permalink,media_type,media_product_type,shortcode,timestamp,caption' },
  });
}

export interface PublishingLimit {
  quota_usage: number;
  config?: { quota_total: number; quota_duration: number };
}

export async function publishingLimit(userId: string, token: string): Promise<PublishingLimit> {
  const res = await request<{ data: PublishingLimit[] }>(`${userId}/content_publishing_limit`, {
    token,
    params: { fields: 'quota_usage,config' },
  });
  return res.data?.[0] ?? { quota_usage: 0 };
}
