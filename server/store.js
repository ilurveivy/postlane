import { verificationMode } from './runtime-policy.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const dataDir = path.resolve(process.env.DATA_DIR || 'data');
if (!verificationMode) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (!verificationMode && fs.existsSync(path.join(dataDir, '.restored-readonly')))
  throw Error('此数据是恢复副本，自动发送已锁定。请先离线核对恢复记录。');
// One queue owner per database. A second launch must not recover a live queue.
if (!verificationMode) {
  const lockPath = path.join(dataDir, 'server.lock');
  if (fs.existsSync(lockPath)) {
    const owner = Number(fs.readFileSync(lockPath, 'utf8'));
    let alive = true;
    if (Number.isInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (error.code === 'ESRCH') alive = false;
      }
    }
    if (alive) throw new Error('此数据目录已有运行中的邮序实例，请先停止原服务');
    fs.unlinkSync(lockPath);
  }
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, String(process.pid));
  fs.closeSync(lock);
  process.once('exit', () => {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath);
    } catch {}
  });
}
const keyPath = path.join(dataDir, 'secret.key');
if (!verificationMode && !fs.existsSync(keyPath))
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
// Read-only demo mode must work on a fresh checkout, so with no key on disk it uses an
// ephemeral one (nothing is encrypted anyway — verify mode cannot write).
const key =
  verificationMode && !fs.existsSync(keyPath) ? randomBytes(32) : fs.readFileSync(keyPath);
const databasePath = path.join(dataDir, 'postlane.sqlite');
// Same reasoning for the database: an existing file is opened read-only, a missing one
// becomes an empty in-memory database so the interface can still be explored.
const memoryOnly = verificationMode && !fs.existsSync(databasePath);
export const db = memoryOnly
  ? new Database(':memory:')
  : new Database(databasePath, verificationMode ? { readonly: true, fileMustExist: true } : {});
if (memoryOnly || !verificationMode)
  db.exec(
    'CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id))',
  );
if (verificationMode) db.pragma('query_only = ON');
else db.pragma('journal_mode = WAL');
export const all = (kind) =>
  db
    .prepare('SELECT json FROM documents WHERE kind=? ORDER BY rowid DESC')
    .all(kind)
    .map((r) => JSON.parse(r.json));
export const get = (kind, id) => {
  const r = db.prepare('SELECT json FROM documents WHERE kind=? AND id=?').get(kind, id);
  return r ? JSON.parse(r.json) : null;
};
export const put = (kind, value) => {
  db.prepare(
    'INSERT INTO documents(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json',
  ).run(kind, value.id, JSON.stringify(value));
  return value;
};
export const remove = (kind, id) =>
  db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, id);
export function encrypt(value) {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, c.update(value, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}
export function decrypt(value) {
  const b = Buffer.from(value, 'base64'),
    d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString('utf8');
}
