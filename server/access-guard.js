import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const isWindows = process.platform === 'win32';

/**
 * Optional HTTP Basic authentication for the web UI.
 *
 * Configuration (environment):
 *   POSTLANE_ACCESS_MODE=basic|off     default: basic
 *   POSTLANE_ACCESS_PASSWORD           at least 32 characters
 *   POSTLANE_ACCESS_PASSWORD_FILE      path to a private file holding the password
 *   POSTLANE_PUBLIC_ORIGIN             https://mail.example.com — the origin the UI is
 *                                      served from behind a reverse proxy; also used for
 *                                      the CSRF origin check
 *
 * With no password configured the guard stays open, so `npm run dev` on localhost needs
 * no setup. Set a password before exposing the app to anything but loopback.
 *
 * When a password is configured the HTTP Basic username is `postlane`; the password is
 * whatever you configured.
 */
export function createAccessGuard(env = process.env, files = fs) {
  const mode = env.POSTLANE_ACCESS_MODE || 'basic';
  if (!['basic', 'off'].includes(mode)) throw new Error('Invalid POSTLANE_ACCESS_MODE');

  let publicOrigin = '';
  if (env.POSTLANE_PUBLIC_ORIGIN) {
    const url = new URL(env.POSTLANE_PUBLIC_ORIGIN);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('POSTLANE_PUBLIC_ORIGIN must be a plain HTTPS origin');
    publicOrigin = url.origin;
  }

  const guard = (authenticate) => ({
    publicOrigin,
    publicHost: publicOrigin ? new URL(publicOrigin).hostname : '',
    authenticate,
  });

  if (mode === 'off') return guard(() => true);

  if (env.POSTLANE_ACCESS_PASSWORD && env.POSTLANE_ACCESS_PASSWORD_FILE)
    throw new Error('Set POSTLANE_ACCESS_PASSWORD or POSTLANE_ACCESS_PASSWORD_FILE, not both');

  let password = env.POSTLANE_ACCESS_PASSWORD || '';
  const file = env.POSTLANE_ACCESS_PASSWORD_FILE;
  if (file) {
    const flags = fs.constants.O_RDONLY | (isWindows ? 0 : fs.constants.O_NOFOLLOW);
    const fd = files.openSync(file, flags);
    try {
      const stat = files.fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536)
        throw new Error('Access password file must be a regular file under 64 KB');
      if (!isWindows && stat.mode & 0o077)
        throw new Error('Access password file must not be readable by other users (chmod 600)');
      password = files.readFileSync(fd, 'utf8').trim();
    } finally {
      files.closeSync(fd);
    }
  }

  if (!password) return guard(() => true);
  if (password.length < 32)
    throw new Error('POSTLANE_ACCESS_PASSWORD must have at least 32 characters');
  if (/[\r\n]/.test(password)) throw new Error('POSTLANE_ACCESS_PASSWORD must be a single line');

  const expected = Buffer.from(`postlane:${password}`);
  return guard((header = '') => {
    if (!/^Basic [A-Za-z0-9+/]+=*$/i.test(header)) return false;
    const supplied = Buffer.from(header.slice(6), 'base64');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}
