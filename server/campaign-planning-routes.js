// Attach inside the application's existing authentication, CSRF and mode guards.
// Async handlers work with both the local adapter and the cloud business store.
export function attachCampaignPlanningRoutes(app, service) {
  const route = (handler) => (req, res, next) =>
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(next);
  app.get(
    '/api/import-accounts',
    route(async (_, res) => res.json(await service.eligibleAccounts())),
  );
  app.get(
    '/api/campaign-builder/sources',
    route(async (_, res) => res.json(await service.builderSources())),
  );
  app.post(
    '/api/campaign-builder/preview',
    route(async (req, res) => res.json(await service.previewBuilder(req.body))),
  );
  app.post(
    '/api/campaign-builder',
    route(async (req, res) => res.json(await service.createBuilder(req.body))),
  );
  app.post(
    '/api/import-batch',
    route(async (req, res) => res.json(await service.importBatch(req.body))),
  );
  app.post(
    '/api/report-batches/:id/start',
    route(async (req, res) => {
      if (req.body?.confirmLive !== true) throw Error('请确认批次真实发送');
      res.json(await service.startBatch(req.params.id));
    }),
  );
}
