import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config, ENV_FILE, ROOT } from './config.ts';

const UNIT_DIR = join(homedir(), '.config/systemd/user');
const NAME = config.profile ? `ig-publisher-${config.profile}` : 'ig-publisher';

function systemctl(...args: string[]): string {
  return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8' }).trim();
}

/** Installs a user-level systemd timer that runs `ig tick` every `everyMinutes` (and catches up after sleep). */
export function installScheduler(everyMinutes = 5): string[] {
  mkdirSync(UNIT_DIR, { recursive: true });
  writeFileSync(
    join(UNIT_DIR, `${NAME}.service`),
    `[Unit]
Description=${NAME}: publish due Instagram posts and refresh the token
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${ROOT}
Environment=PATH=${process.env.PATH}
${config.profile ? `Environment=IG_ENV_FILE=${ENV_FILE}\n` : ''}ExecStart=${process.execPath} --disable-warning=ExperimentalWarning ${join(ROOT, 'src/cli.ts')} tick
TimeoutStartSec=2h
`,
  );
  writeFileSync(
    join(UNIT_DIR, `${NAME}.timer`),
    `[Unit]
Description=Run ig-publisher tick every ${everyMinutes} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${everyMinutes}min
Persistent=true

[Install]
WantedBy=timers.target
`,
  );
  systemctl('daemon-reload');
  systemctl('enable', '--now', `${NAME}.timer`);
  const notes = [`timer o‘rnatildi: har ${everyMinutes} daqiqada \`ig tick\``];
  try {
    const linger = execFileSync('loginctl', ['show-user', process.env.USER ?? '', '--property=Linger'], { encoding: 'utf8' });
    if (!/Linger=yes/.test(linger)) {
      notes.push('Diqqat: tizimdan chiqqaningizda ham ishlashi uchun bir marta: sudo loginctl enable-linger $USER');
    }
  } catch {
    /* loginctl unavailable */
  }
  return notes;
}

export function uninstallScheduler(): void {
  try {
    systemctl('disable', '--now', `${NAME}.timer`);
  } catch {
    /* not installed */
  }
  for (const f of [`${NAME}.service`, `${NAME}.timer`]) rmSync(join(UNIT_DIR, f), { force: true });
  systemctl('daemon-reload');
}

export function schedulerStatus(): string {
  if (!existsSync(join(UNIT_DIR, `${NAME}.timer`))) return 'o‘rnatilmagan (`ig scheduler install`)';
  try {
    const active = systemctl('is-active', `${NAME}.timer`);
    const next = systemctl('show', `${NAME}.timer`, '--property=NextElapseUSecRealtime', '--value');
    return `${active}${next ? `, keyingi ishga tushish: ${next}` : ''}`;
  } catch (err) {
    return `holatni olib bo‘lmadi: ${(err as Error).message}`;
  }
}
