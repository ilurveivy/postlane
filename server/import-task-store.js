import { randomUUID } from 'node:crypto';
import { importTaskWorkspace, taskMetadata } from './import-task-domain.js';
export function createImportTaskStore({ all, get, put }) {
  function attachImportTask(list, input) {
    if (list.importTaskId && get('import-task', list.importTaskId)) return list;
    const task = {
      ...taskMetadata(input),
      id: randomUUID(),
      sourceListIds: [list.id],
      origin: 'import',
      schemaVersion: 1,
      createdAt: list.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Keep lineage even if the editable working list is later removed. This kind is never queued.
    put('import-source', { ...list, originalRows: input.rows || [] });
    put('import-task', task);
    return { ...list, importTaskId: task.id };
  }
  function taskWorkspace() {
    return importTaskWorkspace({
      tasks: all('import-task'),
      lists: [...all('import-source'), ...all('list')],
      campaigns: all('campaign'),
      receipts: all('batch-import'),
      events: all('mail-event'),
      replies: all('reply-draft'),
      messages: all('inbox-message'),
    });
  }
  function renameImportTask(id, input) {
    const old = taskWorkspace().items.find((t) => t.id === id && t.origin !== 'unknown');
    if (!old) throw Error('导入任务不存在');
    const { counts, campaignIds, accountIds, complete, ...metadata } = old;
    return put('import-task', {
      ...metadata,
      ...taskMetadata({ ...metadata, ...input }),
      updatedAt: new Date().toISOString(),
    });
  }

  return { attachImportTask, taskWorkspace, renameImportTask };
}
