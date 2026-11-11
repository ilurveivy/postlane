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
/**
 * A one-line warning for the cases where the app is reachable by someone else while no
 * password is in force. Returning a string instead of logging keeps it testable, and it is
 * deliberately advisory: refusing to boot would break a first `docker compose up`, where
 * the password is still empty by design.
 */
export function accessWarning(env = process.env, { bindHost = '127.0.0.1', lan = false } = {}) {
  const mode = env.POSTLANE_ACCESS_MODE || 'basic';
  const hasPassword = Boolean(env.POSTLANE_ACCESS_PASSWORD || env.POSTLANE_ACCESS_PASSWORD_FILE);
  const exposed =
    lan || (bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost');
  // Console output stays ASCII English like the rest of the server, so a Windows console
  // in a legacy code page does not turn the warning into noise.
  if (!exposed)
    return hasPassword
      ? ''
      : 'No POSTLANE_ACCESS_PASSWORD set: the UI is unauthenticated, local use only.';
  if (mode === 'off')
    return `POSTLANE_ACCESS_MODE=off while listening on ${bindHost}: anyone who can reach this port can operate every mail account.`;
  if (!hasPassword)
    return (
      `No POSTLANE_ACCESS_PASSWORD set while listening on ${bindHost}: anyone who can reach this ` +
      'port can operate every mail account. Set a password (32+ chars) or bind to 127.0.0.1.'
    );
  return '';
}

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
