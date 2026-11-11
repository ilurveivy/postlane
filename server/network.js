import { execFileSync } from 'node:child_process';

export function macHttpProxy(output) {
  const value = (key) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))?.[1].trim();
  for (const prefix of ['HTTPS', 'HTTP']) {
    const host = value(prefix + 'Proxy');
    const port = Number(value(prefix + 'Port'));
    if (
      value(prefix + 'Enable') === '1' &&
      host &&
      /^[a-zA-Z0-9.-]+$/.test(host) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535
    ) {
      return `http://${host}:${port}`;
    }
  }
}
export function smtpProxy(host) {
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return undefined;
  if (process.env.SMTP_PROXY) {
    const url = new URL(process.env.SMTP_PROXY);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('SMTP_PROXY 仅支持 HTTP CONNECT 代理');
    return url.toString();
  }
  // Gmail web login follows the existing macOS proxy; use the same route for SMTP.
  // TLS remains end-to-end and certificate validation is never disabled.
  if (process.platform === 'darwin' && host === 'smtp.gmail.com') {
    try {
      return macHttpProxy(
        execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 }),
      );
    } catch {
      return undefined;
    }
  }
}
