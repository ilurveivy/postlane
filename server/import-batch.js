import { attachImportTask } from './import-tasks.js';
import { all, get, put, db } from './store.js';
import { createBatch } from './batch-reports.js';
import { selectEligibleAccounts } from './eligible-accounts.js';
import { createImportBatch } from './import-batch-core.js';
export const eligibleAccounts = () => selectEligibleAccounts(all('account'), all('campaign'));
export const { importBatch, startBatch } = createImportBatch({
  attachImportTask,
  all,
  get,
  put,
  transaction: (callback) => db.transaction(callback),
  eligibleAccounts,
  createBatch,
});
