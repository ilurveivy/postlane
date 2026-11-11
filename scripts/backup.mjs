import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
const root = path.resolve(new URL('..', import.meta.url).pathname);
// Prefer 	ar from PATH: bsdtar ships with Windows 10+ and every Linux/macOS system.
const tarBin = process.env.POSTLANE_TAR || 'tar';
// A downloaded release or a Docker image has no .git directory; the manifest must not fail then.
const gitRevision = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};
const configDir = process.env.POSTLANE_CONFIG_DIR || path.join(os.homedir(), '.config/Postlane');
const backupDir = process.env.POSTLANE_BACKUP_DIR || path.join(os.homedir(), 'Postlane-backups');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const statusPath = path.join(configDir, 'backup-status.json');
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const prior = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath)) : {};
if (prior.date === date && prior.remoteVerified && !process.argv.includes('--force'))
  process.exit(0);
const lockPath = path.join(configDir, 'backup.lock');
if (fs.existsSync(lockPath)) {
  const pid = Number(fs.readFileSync(lockPath));
  try {
    process.kill(pid, 0);
    process.exit(0);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
    fs.unlinkSync(lockPath);
  }
}
fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
const writeStatus = (s) => {
  const p = statusPath + '.tmp';
  fs.writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(p, statusPath);
};
let state = {
  ...prior,
  date,
  localVerified: prior.date === date && prior.localVerified,
  remoteVerified: false,
  startedAt: new Date().toISOString(),
  status: 'running',
};
writeStatus(state);
let stage;
try {
  const keyPath = path.join(configDir, 'backup-recovery.key');
  if (!fs.existsSync(keyPath))
    fs.writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  const key = fs.readFileSync(keyPath);
  // Reuse a verified local encrypted archive after an upload failure.
  if (
    !(prior.date === date && prior.localVerified && fs.existsSync(prior.file)) ||
    process.argv.includes('--force')
  ) {
    const version = new Date().toISOString().replaceAll(':', '-');
    stage = fs.mkdtempSync(path.join(backupDir, '.stage-'));
    fs.chmodSync(stage, 0o700);
    fs.mkdirSync(path.join(stage, 'data'));
    const db = new Database(path.join(dataDir, 'postlane.sqlite'), { readonly: true });
    try {
      await db.backup(path.join(stage, 'data/postlane.sqlite'));
    } finally {
      db.close();
    }
    for (const f of fs.readdirSync(dataDir)) {
      if (/^(postlane.sqlite(?:-.*)?|server.lock)$/.test(f)) continue;
      fs.cpSync(path.join(dataDir, f), path.join(stage, 'data', f), { recursive: true });
    }
    if (fs.existsSync(path.join(root, 'outputs')))
      fs.cpSync(path.join(root, 'outputs'), path.join(stage, 'outputs'), {
        recursive: true,
        dereference: false,
      });
    const snap = new Database(path.join(stage, 'data/postlane.sqlite'), { readonly: true });
    const check = snap.pragma('integrity_check');
    if (check.some((r) => r.integrity_check !== 'ok'))
      throw Error('Snapshot integrity check failed');
    const counts = snap.prepare('SELECT kind,count(*) n FROM documents GROUP BY kind').all();
    snap.close();
    const files = [];
    function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.isFile())
          files.push({
            path: path.relative(stage, f),
            bytes: fs.statSync(f).size,
            sha256: createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
          });
      }
    }
    walk(stage);
    fs.writeFileSync(
      path.join(stage, 'manifest.json'),
      JSON.stringify(
        {
          version,
          date,
          counts,
          files,
          git: gitRevision(),
        },
        null,
        2,
      ),
    );
    const archive = path.join(backupDir, version + '.tar.gz');
    execFileSync(tarBin, ['-czf', archive, '-C', stage, '.'], { timeout: 300000 });
    const output = archive + '.enc',
      iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    fs.writeFileSync(output, Buffer.concat([Buffer.from('POSTLANE2'), iv]), { mode: 0o600 });
    await pipeline(
      fs.createReadStream(archive),
      cipher,
      fs.createWriteStream(output, { flags: 'a' }),
    );
    fs.appendFileSync(output, cipher.getAuthTag());
    // Authenticate and restore the encrypted artifact itself, not just the pre-encryption snapshot.
    const bytes = fs.statSync(output).size,
      decipher = createDecipheriv('aes-256-gcm', key, iv);
    const fd = fs.openSync(output, 'r'),
      tag = Buffer.alloc(16);
    fs.readSync(fd, tag, 0, 16, bytes - 16);
    fs.closeSync(fd);
    decipher.setAuthTag(tag);
    const restoreTar = path.join(backupDir, '.restore-' + version + '.tgz');
    await pipeline(
      fs.createReadStream(output, { start: 21, end: bytes - 17 }),
      decipher,
      fs.createWriteStream(restoreTar, { mode: 0o600 }),
    );
    const restore = fs.mkdtempSync(path.join(backupDir, '.restore-'));
    execFileSync(tarBin, ['-xzf', restoreTar, '-C', restore]);
    for (const f of files) {
      if (
        createHash('sha256')
          .update(fs.readFileSync(path.join(restore, f.path)))
          .digest('hex') !== f.sha256
      )
        throw Error('Restore checksum mismatch');
    }
    const restored = new Database(path.join(restore, 'data/postlane.sqlite'), { readonly: true });
    if (restored.pragma('integrity_check', { simple: true }) !== 'ok')
      throw Error('Restored DB invalid');
    restored.close();
    fs.rmSync(restore, { recursive: true });
    fs.unlinkSync(restoreTar);
    fs.unlinkSync(archive);
    fs.rmSync(stage, { recursive: true });
    stage = null;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(output)) hash.update(chunk);
    state = {
      ...state,
      file: output,
      sha256: hash.digest('hex'),
      localVerified: true,
      remoteVerified: false,
      remoteKey: `postlane-backups/${date}/${path.basename(output)}`,
    };
    writeStatus(state);
  } else state = { ...state, ...prior, status: 'running', startedAt: new Date().toISOString() };
  // Optional off-machine copy. Any directory that survives this host is fine: an
  // NFS/SMB mount, an rclone mount, or a synced folder. We copy, then read the copy
  // back and compare sha256, so a truncated or half-synced copy is never marked
  // verified. Without POSTLANE_BACKUP_REMOTE_DIR the backup is local-only.
  const remoteDir = process.env.POSTLANE_BACKUP_REMOTE_DIR;
  if (!remoteDir) {
    writeStatus({
      ...state,
      status: 'ok',
      remoteVerified: false,
      remoteKey: '',
      completedAt: new Date().toISOString(),
      error: '',
    });
    console.log(JSON.stringify({ ok: true, file: state.file, remoteVerified: false }));
  } else {
    const remoteKey = path.join(remoteDir, date, path.basename(output));
    fs.mkdirSync(path.dirname(remoteKey), { recursive: true });
    fs.copyFileSync(state.file, remoteKey);
    const remoteHash = createHash('sha256');
    for await (const chunk of fs.createReadStream(remoteKey)) remoteHash.update(chunk);
    if (remoteHash.digest('hex') !== state.sha256) throw Error('Remote backup checksum mismatch');
    writeStatus({
      ...state,
      status: 'ok',
      remoteVerified: true,
      remoteKey,
      completedAt: new Date().toISOString(),
      error: '',
    });
    console.log(JSON.stringify({ ok: true, file: state.file, remoteKey }));
  }
} catch (e) {
  writeStatus({ ...state, status: 'error', error: e.message, failedAt: new Date().toISOString() });
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
  fs.unlinkSync(lockPath);
}
