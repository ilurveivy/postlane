import { attachImportTask } from './import-tasks.js';
import { all, get, put, db } from './store.js';
import { eligibleAccounts } from './import-batch.js';
import { createBatch } from './batch-reports.js';
import { createCampaignBuilder } from './campaign-builder-core.js';
export { archiveRecipients } from './report-recipients.js';

export const { builderSources, previewBuilder, createBuilder } = createCampaignBuilder({
  attachImportTask,
  all,
  get,
  put,
  transaction: (callback) => db.transaction(callback),
  eligibleAccounts,
  createBatch,
});
