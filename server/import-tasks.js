import { createImportTaskStore } from './import-task-store.js';
import { randomUUID } from 'node:crypto';
import { all, get, put, db } from './store.js';
import { importTaskWorkspace, taskMetadata } from './import-task-domain.js';
export const { attachImportTask } = createImportTaskStore({ all, get, put });
let cached, cacheVersion;
export function taskWorkspace() {
  const version = `${db.pragma('data_version', { simple: true })}:${db.prepare('SELECT total_changes() AS n').get().n}`;
  if (cached && cacheVersion === version) return cached;
  cached = importTaskWorkspace({
    tasks: all('import-task'),
    lists: [...all('import-source'), ...all('list')],
    campaigns: all('campaign'),
    receipts: all('batch-import'),
    events: all('mail-event'),
    replies: all('reply-draft'),
    messages: all('inbox-message'),
  });
  cacheVersion = version;
  return cached;
}
export function renameImportTask(id, input) {
  const old = taskWorkspace().items.find((t) => t.id === id && t.origin !== 'unknown');
  if (!old) throw Error('导入任务不存在');
  const { counts, campaignIds, accountIds, complete, ...metadata } = old;
  return put('import-task', {
    ...metadata,
    ...taskMetadata({ ...metadata, ...input }),
    updatedAt: new Date().toISOString(),
  });
}
