import { workersEnabled } from './runtime-policy.js';
import { all, get, put } from './store.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
const dir = process.env.POSTLANE_CONFIG_DIR || path.join(os.homedir(), '.config/Postlane');
// Daily backups run only when explicitly enabled: either POSTLANE_BACKUP_ENABLED=true or a
// backup.json marker in the config directory. Local-only backups are the default; set
// POSTLANE_BACKUP_REMOTE_DIR to also copy each archive off this machine.
const enabled = () =>
  fs.existsSync(path.join(dir, 'backup.json')) || process.env.POSTLANE_BACKUP_ENABLED === 'true';
export function backupState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'backup-status.json')));
    return { ...s, configured: enabled() };
  } catch {
    return { configured: enabled(), status: 'not_started' };
  }
}
let active = false;
function tick() {
  if (!workersEnabled) return;
  const s = backupState();
  if (active || !s.configured) return;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  // Local-only runs have remoteVerified=false forever, so a completed run also counts as done.
  if (s.date === today && (s.remoteVerified || s.status === 'ok')) return;
  if (s.status === 'error') {
    const id = 'backup-failure:' + today;
    const adminEmail = process.env.POSTLANE_ADMIN_EMAIL;
    const account = all('account').find(
      (a) => (!a.provider || a.provider === 'smtp') && a.password,
    );
    if (!get('batch-report', id) && account && adminEmail)
      put('batch-report', {
        id,
        batchId: id,
        kind: 'progress',
        recoveryVersion: 2,
        accountId: account.id,
        mode: 'live',
        subject: '[Postlane] 每日备份异常 · ' + today,
        text:
          '每日备份未完成：' +
          (s.error || '未知错误') +
          '\n已有备份保留。服务每 15 分钟重试，请在批次页查看备份状态。',
        createdAt: new Date().toISOString(),
        deliveries: [
          {
            email: adminEmail,
            status: 'pending',
            attempts: 0,
            nextAt: 0,
            messageId: `<${randomUUID()}@postlane.local>`,
          },
        ],
      });
    if (Date.now() - Date.parse(s.failedAt) < 15 * 60000) return;
  }
  active = true;
  const child = spawn(process.execPath, [path.resolve('scripts/backup.mjs')], { stdio: 'ignore' });
  child.once('exit', () => {
    active = false;
  });
  child.once('error', () => {
    active = false;
  });
}
// Only the `configured` gate inside tick() decides whether a backup actually runs, so a
// custom DATA_DIR (the normal container case) must not disable the scheduler.
if (workersEnabled && process.env.DISABLE_BACKUP !== 'true') {
  setInterval(tick, 60000).unref();
  setTimeout(tick, 10000).unref();
}
