import { config } from './config.ts';
import { log, redact } from './log.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function telegramEnabled(): boolean {
  return Boolean(config.telegramToken && config.telegramChatId);
}

/** Best effort: a failed notification never fails the publish. Message is Telegram HTML. */
export async function notify(html: string): Promise<void> {
  if (!telegramEnabled()) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: false } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log(`telegram xabar yuborilmadi: HTTP ${res.status} ${redact(await res.text()).slice(0, 200)}`);
  } catch (err) {
    log(`telegram xabar yuborilmadi: ${(err as Error).message}`);
  }
}

export function notifyPublished(p: { type: string; label?: string; permalink?: string; mediaId: string }) {
  const title = p.label ? `${esc(p.label)} (${p.type})` : p.type;
  return notify(`✅ Instagram: <b>${title}</b> joylandi\n${p.permalink ? esc(p.permalink) : `media id ${p.mediaId}`}`);
}

export function notifyFailed(p: { type?: string; label?: string; error: string; willRetry?: boolean }) {
  const title = p.label ?? p.type ?? 'post';
  return notify(
    `${p.willRetry ? '⚠️' : '❌'} Instagram: <b>${esc(title)}</b> joylanmadi\n<code>${esc(p.error.slice(0, 800))}</code>` +
      (p.willRetry ? '\nKeyinroq qayta urinadi.' : ''),
  );
}

export function notifyText(text: string) {
  return notify(esc(text));
}
