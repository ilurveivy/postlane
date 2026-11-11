import { networkInterfaces } from 'node:os';
export function privateAddress(address = '') {
  const ip = address.replace(/^::ffff:/, '');
  if (ip === '::1') return true;
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    p[0] === 127 ||
    p[0] === 10 ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
  );
}
export function allowedHosts(lan) {
  const hosts = ['localhost', '127.0.0.1', '[::1]'];
  if (lan)
    for (const entries of Object.values(networkInterfaces()))
      for (const entry of entries || [])
        if (entry.family === 'IPv4' && privateAddress(entry.address)) hosts.push(entry.address);
  return hosts;
}
