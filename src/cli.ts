import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config } from './config.ts';
import { closeDb } from './db.ts';
import {
  authorizeUrl,
  clearToken,
  fetchMe,
  getAuth,
  loadToken,
  loginWithCode,
  refreshIfNeeded,
  storeToken,
  tokenDaysLeft,
} from './api/auth.ts';
import { GraphError } from './api/http.ts';
import { accountInsights, listComments, listMedia, mediaInsights, replyToComment, setCommentHidden } from './api/media.ts';
import { publishingLimit } from './api/publish.ts';
import { log, setQuiet } from './log.ts';
import { check, type Target } from './media/probe.ts';
import { notifyText, telegramEnabled } from './notify.ts';
import {
  cancelQueueItem,
  enqueue,
  fromSql,
  getQueueItem,
  listQueue,
  rescheduleQueueItem,
  runDue,
  tick,
} from './queue.ts';
import { installScheduler, schedulerStatus, uninstallScheduler } from './scheduler.ts';
import { DuplicateError, getPost, listPosts, publish } from './service.ts';
import { loadSpecFile, normalizeSpec, POST_TYPES, type PostSpec, type PostType } from './spec.ts';

const HELP = `ig — Instagram publisher (Instagram Login yoki IG_LOGIN=facebook: Facebook Login + sahifa)

Avtorizatsiya:
  ig auth token <TOKEN|->        Dashboard / Graph API Explorer tokenini saqlash (- = stdin)
  ig auth url                    OAuth havolasi (brauzerda oching)
  ig auth login <code|URL>       Redirect URL/code'ni tokenga almashtirish
  ig auth status | refresh | logout

Joylash:
  ig post reel <video>      [opsiyalar]
  ig post image <rasm>      [opsiyalar]
  ig post carousel <f1> <f2> ... [opsiyalar]
  ig post story <fayl>      [opsiyalar]
  ig post --spec post.json  [--at ...]
    --caption TEXT | --caption-file FILE   --cover IMG      --thumb-offset MS
    --no-feed (reel faqat Reels'da)         --collab u1,u2   --location ID
    --tag user[:x:y],...  --alt TEXT  --audio-name NAME  --ai  --trial MANUAL|SS_PERFORMANCE
    --label NOM   --at VAQT (navbatga: +2h, 09:00, "ertaga 09:00", "2026-10-27 18:30")
    --dry-run (faqat tekshirish)   --force (dublikat bo‘lsa ham)   --no-fix (ffmpeg tuzatmasin)

Navbat va jadval:
  ig queue [--all]          ig queue show|cancel <id>     ig queue retry <id> [--at VAQT]
  ig queue run              (hozir vaqti kelganlarni joylash)
  ig tick                   (token yangilash + navbat; timer shuni chaqiradi)
  ig scheduler install [--every 5] | uninstall | status

Ma’lumot:
  ig check <fayl> [--as reel|story|feed|carousel|cover]   ig history [--limit N] [--status S]
  ig limit    ig media [--limit N]    ig insights <media-id|account> [--metrics a,b]
  ig comments <media-id>    ig reply <comment-id> <matn>
  ig hide <comment-id>      ig unhide <comment-id>
  ig doctor   ig notify-test

Umumiy: --json (stdout'ga JSON), --quiet`;

const OPTIONS = {
  caption: { type: 'string' },
  'caption-file': { type: 'string' },
  cover: { type: 'string' },
  'thumb-offset': { type: 'string' },
  'no-feed': { type: 'boolean' },
  collab: { type: 'string' },
  location: { type: 'string' },
  tag: { type: 'string' },
  alt: { type: 'string' },
  'audio-name': { type: 'string' },
  ai: { type: 'boolean' },
  trial: { type: 'string' },
  label: { type: 'string' },
  at: { type: 'string' },
  spec: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  'no-fix': { type: 'boolean' },
  as: { type: 'string' },
  limit: { type: 'string' },
  status: { type: 'string' },
  all: { type: 'boolean' },
  every: { type: 'string' },
  metrics: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

class UsageError extends Error {}

type Values = ReturnType<typeof parse>['values'];
function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

let asJson = false;
function out(human: string, data?: unknown): void {
  if (asJson) process.stdout.write(JSON.stringify(data ?? { message: human }, null, 2) + '\n');
  else process.stdout.write(human + '\n');
}

const localTime = (d: Date) =>
  d.toLocaleString('uz-UZ', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

function specFromArgs(type: PostType, files: string[], v: Values): PostSpec {
  const spec: PostSpec = { type, media: files };
  if (v.caption !== undefined) spec.caption = v.caption.replace(/\\n/g, '\n');
  if (v['caption-file']) spec.captionFile = v['caption-file'];
  if (v.cover) spec.cover = v.cover;
  if (v['thumb-offset']) spec.thumbOffsetMs = Number(v['thumb-offset']);
  if (v['no-feed']) spec.shareToFeed = false;
  if (v.collab) spec.collaborators = v.collab.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
  if (v.location) spec.locationId = v.location;
  if (v.tag) {
    spec.userTags = v.tag.split(',').map((t) => {
      const [username, x, y] = t.trim().replace(/^@/, '').split(':');
      return x !== undefined ? { username, x: Number(x), y: Number(y) } : { username };
    });
  }
  if (v.alt) spec.altText = v.alt;
  if (v['audio-name']) spec.audioName = v['audio-name'];
  if (v.ai) spec.aiGenerated = true;
  if (v.trial) spec.trial = v.trial.toUpperCase() as PostSpec['trial'];
  if (v.label) spec.label = v.label;
  if (v['no-fix']) spec.fix = false;
  return spec;
}

async function cmdPost(pos: string[], v: Values): Promise<number> {
  let spec: PostSpec;
  if (v.spec) {
    spec = loadSpecFile(v.spec);
    if (v.label) spec.label = v.label;
  } else {
    const [type, ...files] = pos;
    if (!POST_TYPES.includes(type as PostType)) throw new UsageError(`ig post <${POST_TYPES.join('|')}> <fayl...>`);
    if (!files.length) throw new UsageError('fayl ko‘rsatilmagan');
    spec = normalizeSpec(specFromArgs(type as PostType, files, v));
  }

  if (v.at && !v['dry-run']) {
    const item = enqueue(spec, v.at);
    out(`navbatga qo‘shildi #${item.id}: ${localTime(fromSql(item.run_at))} da joylanadi` +
      (schedulerStatus().startsWith('active') ? '' : '\nDiqqat: timer o‘rnatilmagan — `ig scheduler install`'), item);
    return 0;
  }

  const res = await publish(spec, { dryRun: v['dry-run'], force: v.force });
  if (res.dryRun) {
    const lines = ['Tekshiruv OK — hech narsa joylanmadi.'];
    for (const c of res.checks ?? []) {
      const p = c.check.probe;
      const desc = p.kind === 'video'
        ? `${p.width}x${p.height} ${p.videoCodec}/${p.audioCodec ?? '-'} ${p.fps?.toFixed(0)}fps ${p.durationSec?.toFixed(1)}s`
        : `${p.width}x${p.height} ${p.videoCodec}`;
      lines.push(`• ${c.file} (${c.target}): ${desc}, ${(p.sizeBytes / 1048576).toFixed(1)}MB` +
        (c.prepared !== c.file ? `\n  tuzatildi → ${c.prepared}` : ''));
      for (const w of c.check.warnings) lines.push(`  ogohlantirish: ${w}`);
    }
    if (spec.caption) lines.push(`caption: ${[...spec.caption].length} belgi`);
    out(lines.join('\n'), res);
    return 0;
  }
  out(`✅ joylandi${res.resumed ? ' (davom ettirildi)' : ''}: ${res.permalink ?? res.mediaId}  [post #${res.postId}]`, res);
  return 0;
}

async function cmdAuth(pos: string[]): Promise<number> {
  const [sub, arg] = pos;
  switch (sub) {
    case 'url':
      out(`1) Quyidagi havolani brauzerda oching va ruxsat bering:\n${authorizeUrl()}\n\n` +
        `2) Brauzer ${config.redirectUri} ga yo‘naltiradi (sahifa ochilmasa ham mayli).\n` +
        `   Manzil satridagi to‘liq URL’ni nusxalab: ig auth login '<URL>'`);
      return 0;
    case 'login': {
      if (!arg) throw new UsageError('ig auth login <code yoki redirect URL>');
      const t = await loginWithCode(arg);
      out(`✅ @${t.username} ulandi, token ${localTime(new Date(t.expiresAt!))} gacha`, { ...t, accessToken: undefined });
      return 0;
    }
    case 'token': {
      const raw = !arg || arg === '-' ? readFileSync(0, 'utf8') : arg;
      const t = await storeToken(raw);
      const until = t.expiresAt ? `taxminan ${localTime(new Date(t.expiresAt))} gacha` : 'muddatsiz';
      out(`✅ @${t.username} (${t.accountType ?? '?'}) saqlandi, token ${until}`, { ...t, accessToken: undefined });
      return 0;
    }
    case 'refresh': {
      if (config.login === 'facebook') {
        out('Facebook sahifa tokeni muddatsiz — yangilash kerak emas');
        return 0;
      }
      await refreshIfNeeded(true);
      const t = loadToken()!;
      out(`✅ token yangilandi, ${localTime(new Date(t.expiresAt!))} gacha`, { expiresAt: t.expiresAt });
      return 0;
    }
    case 'logout':
      clearToken();
      out('token o‘chirildi');
      return 0;
    case 'status':
    case undefined: {
      const t = loadToken();
      if (!t) {
        out('token yo‘q — SETUP.md ga qarang (`ig auth token` yoki `ig auth url`)', { connected: false });
        return 1;
      }
      const me = await fetchMe(t.accessToken);
      const left = tokenDaysLeft(t);
      out(`@${me.username} (${me.account_type ?? '?'}), id ${me.user_id ?? me.id}, ${me.media_count ?? '?'} ta post\n` +
        `token: ${left !== undefined ? `${left.toFixed(1)} kun qoldi` : config.login === 'facebook' ? 'muddatsiz (sahifa tokeni)' : 'muddati noma’lum'}, oxirgi yangilanish ${localTime(new Date(t.issuedAt))}`,
        { connected: true, me, expiresAt: t.expiresAt, daysLeft: left });
      return 0;
    }
    default:
      throw new UsageError('ig auth token|url|login|status|refresh|logout');
  }
}

async function cmdQueue(pos: string[], v: Values): Promise<number> {
  const [sub, idArg] = pos;
  const id = Number(idArg);
  switch (sub) {
    case undefined:
    case 'list': {
      const rows = listQueue(v.all);
      if (!rows.length) {
        out('navbat bo‘sh', []);
        return 0;
      }
      out(rows.map((r) => {
        const s = JSON.parse(r.spec) as PostSpec;
        return `#${r.id} ${r.status.padEnd(9)} ${localTime(fromSql(r.run_at))}  ${s.label ?? s.type} (${s.media.length} fayl)` +
          (r.last_error ? `\n     xato: ${r.last_error.slice(0, 160)}` : '');
      }).join('\n'), rows);
      return 0;
    }
    case 'show': {
      const r = getQueueItem(id);
      if (!r) throw new UsageError(`#${idArg} topilmadi`);
      out(JSON.stringify({ ...r, spec: JSON.parse(r.spec) }, null, 2), { ...r, spec: JSON.parse(r.spec) });
      return 0;
    }
    case 'cancel':
      if (!cancelQueueItem(id)) throw new UsageError(`#${idArg} bekor qilinmadi (pending emas)`);
      out(`#${id} bekor qilindi`);
      return 0;
    case 'retry': {
      const r = rescheduleQueueItem(id, v.at ?? 'now');
      out(`#${id} qayta rejalashtirildi: ${localTime(fromSql(r.run_at))}`, r);
      return 0;
    }
    case 'run': {
      const s = await runDue();
      out(`ishlandi: ${s.processed}, joylandi: ${s.published}, xato: ${s.failed}, qayta urinadi: ${s.retrying}`, s);
      return s.failed ? 1 : 0;
    }
    default:
      throw new UsageError('ig queue [list|show|cancel|retry|run]');
  }
}

async function cmdDoctor(): Promise<number> {
  const rows: [string, boolean, string][] = [];
  rows.push(['login', true, config.login === 'facebook' ? 'Facebook Login + sahifa (graph.facebook.com)' : 'Instagram Login (graph.instagram.com)']);
  rows.push(['IG_APP_ID / IG_APP_SECRET', Boolean(config.appId && config.appSecret),
    config.appId ? 'bor'
      : config.login === 'facebook' ? 'yo‘q — IG_LOGIN=facebook uchun majburiy (App settings → Basic)'
      : 'yo‘q (faqat `ig auth url/login` va qisqa token almashtirish uchun kerak)']);
  rows.push(['ffprobe', Boolean(config.ffprobe), config.ffprobe || 'topilmadi']);
  rows.push(['ffmpeg', Boolean(config.ffmpeg), config.ffmpeg || 'topilmadi']);
  const hostOk = config.host === 'tunnel' ? Boolean(config.cloudflared)
    : config.host === 'static' ? Boolean(config.staticDir && config.staticBaseUrl)
    : config.host === 'command' ? Boolean(config.hostCommand) : false;
  rows.push([`host (${config.host})`, hostOk, config.host === 'tunnel' ? config.cloudflared || 'cloudflared topilmadi' : '']);
  rows.push(['upload rejimi', true, config.uploadMode]);
  const t = loadToken();
  let tokenOk = false;
  let tokenNote = 'yo‘q — `ig auth token`';
  if (t) {
    try {
      const me = await fetchMe(t.accessToken);
      const left = tokenDaysLeft(t);
      tokenOk = left === undefined || left > 3;
      tokenNote = `@${me.username} (${me.account_type ?? '?'}), ` +
        (left !== undefined ? `${left.toFixed(1)} kun qoldi` : config.login === 'facebook' ? 'muddatsiz (sahifa tokeni)' : 'muddati noma’lum');
    } catch (err) {
      tokenNote = err instanceof GraphError ? err.describe() : (err as Error).message;
    }
  }
  rows.push(['token', tokenOk, tokenNote]);
  if (tokenOk) {
    try {
      const { token, userId } = await getAuth();
      const q = await publishingLimit(userId, token);
      rows.push(['publish limit', true, `${q.quota_usage}/${q.config?.quota_total ?? '?'} (24 soat)`]);
    } catch (err) {
      rows.push(['publish limit', false, (err as Error).message]);
    }
  }
  rows.push(['telegram', telegramEnabled(), telegramEnabled() ? 'sozlangan' : 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID yo‘q (ixtiyoriy)']);
  const sched = schedulerStatus();
  rows.push(['scheduler', sched.startsWith('active'), sched]);
  out(rows.map(([name, ok, note]) => `${ok ? '✅' : '⚠️'} ${name}: ${note}`).join('\n'),
    rows.map(([name, ok, note]) => ({ name, ok, note })));
  return rows.some(([n, ok]) => !ok && (n === 'token' || n === 'ffprobe')) ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parse(argv);
  asJson = Boolean(v.json);
  if (v.quiet) setQuiet(true);
  const [cmd, ...pos] = positionals;
  if (!cmd || v.help || cmd === 'help') {
    out(HELP);
    return 0;
  }
  switch (cmd) {
    case 'post':
      return cmdPost(pos, v);
    case 'auth':
      return cmdAuth(pos);
    case 'queue':
      return cmdQueue(pos, v);
    case 'tick': {
      const s = await tick();
      if (s) out(`tick: ishlandi ${s.processed}, joylandi ${s.published}, xato ${s.failed}, qayta ${s.retrying}`, s);
      return 0;
    }
    case 'check': {
      if (!pos[0]) throw new UsageError('ig check <fayl> [--as reel|story|feed|carousel|cover]');
      const target = (v.as ?? (/\.(mp4|mov|m4v|webm|mkv)$/i.test(pos[0]) ? 'reel' : 'feed')) as Target;
      const c = await check(pos[0], target);
      const lines = [`${pos[0]} → ${target}`, JSON.stringify(c.probe)];
      for (const e of c.errors) lines.push(`❌ ${e}`);
      for (const f of c.fixable) lines.push(`🔧 ${f} (avtomatik tuzatiladi)`);
      for (const w of c.warnings) lines.push(`⚠️ ${w}`);
      if (!c.errors.length && !c.fixable.length) lines.push('✅ talablarga mos');
      out(lines.join('\n'), c);
      return c.errors.length ? 1 : 0;
    }
    case 'history': {
      const rows = listPosts(Number(v.limit ?? 20), v.status);
      out(rows.length ? rows.map((r) => {
        const s = JSON.parse(r.spec) as PostSpec;
        return `#${r.id} ${r.status.padEnd(10)} ${r.created_at}  ${s.label ?? r.type}  ${r.permalink ?? r.error?.slice(0, 120) ?? ''}`;
      }).join('\n') : 'tarix bo‘sh', rows);
      return 0;
    }
    case 'post-info': {
      const r = getPost(Number(pos[0]));
      if (!r) throw new UsageError('topilmadi');
      out(JSON.stringify(r, null, 2), r);
      return 0;
    }
    case 'limit': {
      const { token, userId } = await getAuth();
      const q = await publishingLimit(userId, token);
      out(`24 soatda: ${q.quota_usage}/${q.config?.quota_total ?? '?'} post`, q);
      return 0;
    }
    case 'media': {
      const { token, userId } = await getAuth();
      const res = await listMedia(userId, token, Number(v.limit ?? 10));
      out(res.data.map((m) =>
        `${m.id}  ${m.timestamp?.slice(0, 16)}  ${m.media_product_type ?? m.media_type}  ❤${m.like_count ?? 0} 💬${m.comments_count ?? 0}  ${m.permalink}`,
      ).join('\n') || 'post yo‘q', res.data);
      return 0;
    }
    case 'insights': {
      if (!pos[0]) throw new UsageError('ig insights <media-id|account>');
      const { token, userId } = await getAuth();
      const data = pos[0] === 'account'
        ? await accountInsights(userId, token, v.metrics)
        : await mediaInsights(pos[0], token, v.metrics);
      out(Object.entries(data).map(([k, val]) => `${k}: ${typeof val === 'object' ? JSON.stringify(val) : val}`).join('\n'), data);
      return 0;
    }
    case 'comments': {
      if (!pos[0]) throw new UsageError('ig comments <media-id>');
      const { token } = await getAuth();
      const list = await listComments(pos[0], token, Number(v.limit ?? 50));
      out(list.map((c) => {
        const replies = (c.replies?.data ?? []).map((r: any) => `\n    ↳ @${r.username}: ${r.text}`).join('');
        return `${c.id}  @${c.username}: ${c.text}${replies}`;
      }).join('\n') || 'izoh yo‘q', list);
      return 0;
    }
    case 'reply': {
      const [commentId, ...words] = pos;
      if (!commentId || !words.length) throw new UsageError('ig reply <comment-id> <matn>');
      const { token } = await getAuth();
      const r = await replyToComment(commentId, words.join(' '), token);
      out(`javob yuborildi: ${r.id}`, r);
      return 0;
    }
    case 'hide':
    case 'unhide': {
      if (!pos[0]) throw new UsageError(`ig ${cmd} <comment-id>`);
      const { token } = await getAuth();
      const r = await setCommentHidden(pos[0], cmd === 'hide', token);
      out(cmd === 'hide' ? 'izoh yashirildi' : 'izoh qayta ko‘rsatildi', r);
      return 0;
    }
    case 'scheduler': {
      const sub = pos[0] ?? 'status';
      if (sub === 'install') out(installScheduler(Number(v.every ?? 5)).join('\n'));
      else if (sub === 'uninstall') {
        uninstallScheduler();
        out('timer o‘chirildi');
      } else out(`scheduler: ${schedulerStatus()}`, { status: schedulerStatus() });
      return 0;
    }
    case 'doctor':
      return cmdDoctor();
    case 'notify-test':
      if (!telegramEnabled()) throw new UsageError('TELEGRAM_BOT_TOKEN va TELEGRAM_CHAT_ID .env da yo‘q');
      await notifyText('ig-publisher: test xabar ✅');
      out('yuborildi');
      return 0;
    default:
      throw new UsageError(`noma’lum buyruq: ${cmd}\n\n${HELP}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const e = err as Error;
  const message = err instanceof GraphError ? err.describe() : e.message;
  if (asJson) process.stdout.write(JSON.stringify({ error: message, name: e.name }, null, 2) + '\n');
  else process.stderr.write(`[ig] xato: ${message}\n`);
  process.exitCode = err instanceof UsageError || (e as any).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 2
    : err instanceof DuplicateError ? 3 : 1;
} finally {
  closeDb();
}
