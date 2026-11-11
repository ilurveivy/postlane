import { createAccessGuard } from './access-guard.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
export const accessGuard = createAccessGuard();
// Immutable for the process lifetime: activation requires an intentional restart.
export const runtimeMode = process.env.POSTLANE_MODE || 'live';
if (!['live', 'verify'].includes(runtimeMode)) throw new Error('Invalid POSTLANE_MODE');
export const verificationMode = runtimeMode === 'verify';
export let workersEnabled = !verificationMode;
export let draining = false;
let active = 0;
const activity = new AsyncLocalStorage();
export const activeOperations = () => active;
export function beginDrain() {
  draining = true;
  workersEnabled = false;
}
export async function runActivity(fn) {
  assertActivityAllowed();
  const scope = { active: true };
  active++;
  try {
    return await activity.run(scope, fn);
  } finally {
    scope.active = false;
    active--;
  }
}
export async function waitForActivities() {
  while (active) await delay(25);
}
/**
 * Where the HTTP server listens.
 *
 * Binding loopback is the safe default for a desktop install, but inside a container
 * loopback is unreachable through a published port, so images set BIND_HOST=0.0.0.0.
 * Widening the bind does not widen access: `allowedHosts` + `privateAddress` above still
 * decide which requests are answered.
 */
export function bindHost(lan = false, override = process.env.BIND_HOST) {
  const value = String(override ?? '').trim();
  return value || (lan ? '0.0.0.0' : '127.0.0.1');
}
export function assertActivityAllowed() {
  if (verificationMode)
    throw Object.assign(new Error('演示核验模式：禁止发送、同步及外部请求'), {
      code: 'EVERIFICATION',
      status: 403,
    });
  if (draining && !activity.getStore()?.active)
    throw Object.assign(new Error('服务正在停止，请稍后重试'), { code: 'ESHUTDOWN', status: 503 });
}
