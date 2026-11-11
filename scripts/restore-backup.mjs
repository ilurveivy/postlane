import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDecipheriv, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
const [file, keyFile, destination] = process.argv.slice(2);
if (!file || !keyFile || !destination)
  throw Error('Usage: node scripts/restore-backup.mjs ARCHIVE KEY NEW_DIRECTORY');
const dest = path.resolve(destination);
if (fs.existsSync(dest)) throw Error('恢复目标必须是不存在的新目录，禁止覆盖现有数据');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'postlane-restore-'));
fs.chmodSync(temp, 0o700);
try {
  const size = fs.statSync(file).size,
    fd = fs.openSync(file, 'r'),
    header = Buffer.alloc(21),
    tag = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 21, 0);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (header.subarray(0, 9).toString() !== 'POSTLANE2') throw Error('Unsupported backup');
  const dec = createDecipheriv('aes-256-gcm', fs.readFileSync(keyFile), header.subarray(9));
  dec.setAuthTag(tag);
  const archive = path.join(temp, 'restore.tgz');
  await pipeline(
    fs.createReadStream(file, { start: 21, end: size - 17 }),
    dec,
    fs.createWriteStream(archive, { mode: 0o600 }),
  );
  const entries = execFileSync(process.env.POSTLANE_TAR || 'tar', ['-tzf', archive], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).split('\n');
  if (entries.some((e) => e.startsWith('/') || e.split('/').includes('..')))
    throw Error('Unsafe archive paths');
  fs.mkdirSync(dest, { mode: 0o700 });
  execFileSync(process.env.POSTLANE_TAR || 'tar', ['-xzf', archive, '-C', dest]);
  fs.writeFileSync(
    path.join(dest, 'data/.restored-readonly'),
    'Restore requires offline review.\n',
    { mode: 0o600 },
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json')));
  for (const f of manifest.files) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(dest, f.path))) hash.update(chunk);
    if (hash.digest('hex') !== f.sha256) throw Error('Checksum mismatch: ' + f.path);
  }
  const db = new Database(path.join(dest, 'data/postlane.sqlite'), { readonly: true });
  if (db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw Error('Database integrity check failed');
  db.close();
  fs.writeFileSync(
    path.join(dest, 'data/.restored-readonly'),
    'Restore verified. Review pending and uncertain deliveries before explicitly unlocking.\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ verified: true, destination: dest, sendingLocked: true }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
