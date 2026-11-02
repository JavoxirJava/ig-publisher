import { closeSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { refreshIfNeeded } from './api/auth.ts';
import { GraphError } from './api/http.ts';
import { log } from './log.ts';
import { notifyFailed } from './notify.ts';
import { DuplicateError, publish } from './service.ts';
import { normalizeSpec, type PostSpec } from './spec.ts';

export interface QueueRow {
  id: number;
  spec: string;
  run_at: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  last_error: string | null;
  post_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Parses "+30m", "+2h", "+1d", "now", "2026-10-27 09:00", "09:00" (today, or tomorrow if passed),
 * "tomorrow 09:00" / "ertaga 09:00" — all in local time.
 */
export function parseWhen(input: string, now = new Date()): Date {
  const s = input.trim().toLowerCase();
  if (s === 'now' || s === 'hozir') return now;
  const rel = /^\+(\d+)\s*([mhd])$/.exec(s);
  if (rel) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'm' | 'h' | 'd'];
    return new Date(now.getTime() + Number(rel[1]) * ms);
  }
  const tm = /^(?:(tomorrow|ertaga)\s+)?(\d{1,2}):(\d{2})$/.exec(s);
  if (tm) {
    const d = new Date(now);
    d.setHours(Number(tm[2]), Number(tm[3]), 0, 0);
    if (tm[1]) d.setDate(d.getDate() + 1);
    else if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  const abs = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (abs) {
    const [, y, mo, da, h = '9', mi = '0', se = '0'] = abs;
    return new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(se));
  }
  const parsed = Date.parse(input);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  throw new Error(`vaqtni tushunmadim: "${input}" (misollar: +2h, 09:00, ertaga 09:00, 2026-10-27 18:30)`);
}

/** SQLite-friendly UTC timestamp: "YYYY-MM-DD HH:MM:SS". */
const toSql = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
export const fromSql = (s: string) => new Date(s.replace(' ', 'T') + 'Z');

export function enqueue(input: PostSpec, when: Date | string = new Date()): QueueRow {
  const spec = normalizeSpec(input);
  const at = typeof when === 'string' ? parseWhen(when) : when;
  const id = Number(
    getDb().prepare('INSERT INTO queue(spec, run_at) VALUES(?, ?)').run(JSON.stringify(spec), toSql(at)).lastInsertRowid,
  );
  return getQueueItem(id)!;
}

export function getQueueItem(id: number): QueueRow | undefined {
  return getDb().prepare('SELECT * FROM queue WHERE id = ?').get(id) as QueueRow | undefined;
}

export function listQueue(all = false, limit = 50): QueueRow[] {
  const sql = all
    ? 'SELECT * FROM queue ORDER BY id DESC LIMIT ?'
    : `SELECT * FROM queue WHERE status IN ('pending', 'running') ORDER BY run_at ASC LIMIT ?`;
  return getDb().prepare(sql).all(limit) as unknown as QueueRow[];
}

export function cancelQueueItem(id: number): boolean {
  const r = getDb()
    .prepare(`UPDATE queue SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(id);
  return r.changes > 0;
}

export function rescheduleQueueItem(id: number, when: string): QueueRow {
  const r = getDb()
    .prepare(
      `UPDATE queue SET run_at = ?, status = 'pending', updated_at = datetime('now')
       WHERE id = ? AND status IN ('pending', 'failed', 'cancelled')`,
    )
    .run(toSql(parseWhen(when)), id);
  if (!r.changes) throw new Error(`#${id} topilmadi yoki hozir ishlayapti/joylangan`);
  return getQueueItem(id)!;
}

/** Atomically claim the next due item so overlapping runners never publish the same post twice. */
function claimNext(): QueueRow | undefined {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(`SELECT * FROM queue WHERE status = 'pending' AND run_at <= datetime('now') ORDER BY run_at ASC, id ASC LIMIT 1`)
      .get() as QueueRow | undefined;
    if (row) {
      db.prepare(`UPDATE queue SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?`).run(row.id);
    }
    db.exec('COMMIT');
    return row ? getQueueItem(row.id) : undefined;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Items left 'running' by a crashed runner go back to pending after an hour. */
function recoverStale(): void {
  getDb()
    .prepare(`UPDATE queue SET status = 'pending' WHERE status = 'running' AND updated_at < datetime('now', '-60 minutes')`)
    .run();
}

function backoffMinutes(attempt: number, err: unknown): number {
  if (err instanceof GraphError && err.isRateLimit) return 60;
  return [5, 15, 60, 180][Math.min(attempt - 1, 3)];
}

export interface RunSummary {
  processed: number;
  published: number;
  failed: number;
  retrying: number;
}

export async function runDue(): Promise<RunSummary> {
  recoverStale();
  const summary: RunSummary = { processed: 0, published: 0, failed: 0, retrying: 0 };
  for (let item = claimNext(); item; item = claimNext()) {
    summary.processed++;
    const spec = JSON.parse(item.spec) as PostSpec;
    log(`navbat #${item.id} (${spec.label ?? spec.type}) boshlandi, urinish ${item.attempts}`);
    try {
      const res = await publish(spec, { queueId: item.id });
      getDb()
        .prepare(`UPDATE queue SET status = 'done', post_id = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?`)
        .run(res.postId, item.id);
      summary.published++;
    } catch (err) {
      const message = err instanceof GraphError ? err.describe() : (err as Error).message;
      const retryable =
        err instanceof GraphError
          ? !err.isAuth && (err.transient || err.isRateLimit || /container .*: ERROR/.test(message))
          : !(err instanceof DuplicateError) && /network|fetch failed|tunnel|cloudflared|timeout|vaqtida|ERROR/i.test(message);
      const permanent = !retryable || item.attempts >= config.queueMaxAttempts;
      if (permanent) {
        getDb()
          .prepare(`UPDATE queue SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(message, item.id);
        summary.failed++;
      } else {
        const next = new Date(Date.now() + backoffMinutes(item.attempts, err) * 60_000);
        getDb()
          .prepare(`UPDATE queue SET status = 'pending', run_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(toSql(next), message, item.id);
        summary.retrying++;
      }
      log(`navbat #${item.id} xato: ${message}`);
      await notifyFailed({ type: spec.type, label: spec.label, error: message, willRetry: !permanent });
    }
  }
  return summary;
}

/** Single-runner guard for the timer: a lock file that expires after 2 hours. */
function withLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const lock = join(config.dataDir, 'tick.lock');
  try {
    if (Date.now() - statSync(lock).mtimeMs > 2 * 3_600_000) rmSync(lock, { force: true });
  } catch {
    /* no lock */
  }
  let fd: number;
  try {
    fd = openSync(lock, 'wx');
  } catch {
    log('boshqa tick ishlayapti — o‘tkazib yuborildi');
    return Promise.resolve(undefined);
  }
  closeSync(fd);
  return fn().finally(() => rmSync(lock, { force: true }));
}

/** What the systemd timer runs: refresh the token if due, then publish everything that is due. */
export async function tick(): Promise<RunSummary | undefined> {
  getDb();
  return withLock(async () => {
    try {
      if (await refreshIfNeeded()) log('token yangilandi');
    } catch (err) {
      log(`token yangilanmadi: ${(err as Error).message}`);
      await notifyFailed({ label: 'token yangilash', error: (err as Error).message });
    }
    return runDue();
  });
}
