import React, { useEffect, useState } from 'react';
export default function BatchReports({
  api,
  campaigns,
  backup,
  importTasks = [],
  importTaskId = '',
  onImportTaskChange,
}) {
  const [batches, setBatches] = useState([]),
    [name, setName] = useState(''),
    [selected, setSelected] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    api('/report-batches')
      .then(setBatches)
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);
  const assigned = new Set(batches.flatMap((b) => b.campaignIds));
  const drafts = campaigns.filter(
    (c) => c.status === 'draft' && c.mode === 'live' && !assigned.has(c.id),
  );
  const [confirmStart, setConfirmStart] = useState('');
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/report-batches', { method: 'POST', body: { name, campaignIds: selected } });
      setSelected([]);
      setName('');
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const date = (s) => (s ? new Date(s).toLocaleString('zh-CN') : '等待批次结束');
  const labels = {
    pending: '待发送',
    sending: '提交中',
    sent: '已提交',
    failed: '失败',
    uncertain: '正在核对',
    needs_review: '需要人工确认',
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>批次自动报告</h1>
          <p>查看各批次发送汇总；启用自动报告的批次会额外发送报告邮件。</p>
        </div>
      </div>
      <section className="panel" style={{ padding: 24, marginBottom: 20 }}>
        <h3>每日数据备份</h3>
        <p>
          {backup?.status === 'ok'
            ? `最近备份：${date(backup.completedAt)} · 已完成加密、恢复校验及远端校验`
            : backup?.status === 'error'
              ? `备份异常：${backup.error}。已有备份保留，系统会再次尝试。`
              : '每天北京时间00:00备份；关机期间错过的备份在启动后补做。'}
        </p>
      </section>
      <section className="panel" style={{ padding: 24, marginBottom: 20 }}>
        <h3>自动报告收件人（仅适用于已启用报告的批次）</h3>
        <p>
          执行报告：
          {reportRecipients?.execution?.join(' · ') || '未配置（设置 POSTLANE_REPORT_TO）'}
        </p>
        <p>
          12小时核查报告：
          {reportRecipients?.audit?.join(' · ') || '未配置（设置 POSTLANE_AUDIT_REPORT_TO）'}
        </p>
        <p>
          新建多账号任务按所选账号均分，汇总仅在平台查看，留存副本按创建时勾选的邮箱发送。在这里手动归组草稿会启用自动报告。历史已完成任务不会自动补发报告。
        </p>
      </section>
      {drafts.length > 0 && (
        <section className="panel" style={{ padding: 24, marginBottom: 20 }}>
          <h3>将多个任务归为一个批次</h3>
          <input
            style={{
              width: '100%',
              maxWidth: 440,
              padding: '10px 12px',
              border: '1px solid #d9e3f3',
              borderRadius: 8,
            }}
            aria-label="批次名称"
            placeholder="输入批次名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div style={{ display: 'grid', gap: 10, margin: '16px 0' }}>
            {drafts.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id),
                    )
                  }
                />{' '}
                {c.name} · {c.senderEmail || '待选择账号'}
              </label>
            ))}
            {!drafts.length && <p>暂无可归组的真实发送草稿。</p>}
          </div>
          <button
            className="button primary"
            disabled={busy || !name.trim() || !selected.length}
            onClick={create}
          >
            创建报告批次
          </button>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <div className="toolbar">
        <select
          aria-label="报告所属导入任务"
          value={importTaskId}
          onChange={(e) => onImportTaskChange?.(e.target.value)}
        >
          <option value="">全部导入任务</option>
          {importTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span>跨任务报告展示完整批次，筛选不会拆分历史报告。</span>
      </div>
      {batches
        .filter(
          (b) =>
            !importTaskId ||
            b.campaignIds.some((id) =>
              importTasks.find((t) => t.id === importTaskId)?.campaignIds.includes(id),
            ),
        )
        .map((b) => (
          <section className="panel" key={b.id} style={{ padding: 24, marginBottom: 20 }}>
            <h3>{b.name}</h3>
            {b.summary && (
              <div className="batch-metrics">
                <div>
                  <strong>
                    {b.summary.accepted}/{b.summary.planned}
                  </strong>
                  <span>正式邮件已提交</span>
                </div>
                <div>
                  <strong>{b.summary.pending + b.summary.retrying}</strong>
                  <span>待发送 / 重试</span>
                </div>
                <div>
                  <strong>{b.summary.uncertain + b.summary.reviewing + b.summary.failed}</strong>
                  <span>核对 / 异常</span>
                </div>
                <div>
                  <strong>
                    {b.summary.archiveSent}/{b.summary.archivePlanned}
                  </strong>
                  <span>副本已提交</span>
                </div>
              </div>
            )}
            {b.nextActionAt && <p>下次自动处理：{date(b.nextActionAt)}</p>}
            {b.summary?.reviewing > 0 && (
              <p role="alert">
                有邮件需要人工确认，请进入对应发送任务查看原因并操作；其他邮件会继续发送。
              </p>
            )}
            <p>
              {b.originalTaskCount ?? b.campaignIds.length} 个账号任务
              {b.linkedRetryCount ? ` · 已归并${b.linkedRetryCount}次历史补发` : ''} ·{' '}
              {b.completedAt ? '已结束' : '等待所有任务结束'}
              {b.emailReports === false
                ? ' · 仅平台汇总，不发送自动报告'
                : b.auditSkippedReason
                  ? ` · ${b.auditSkippedReason}`
                  : ` · 核查时间：${date(b.auditDueAt)}`}
            </p>
            <details>
              <summary>查看账号任务与历史补发</summary>
              <p>
                {b.campaignIds
                  .map((id) => campaigns.find((c) => c.id === id)?.name || id)
                  .join(' / ')}
              </p>
            </details>
            {!b.startedAt && (
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmStart === b.id}
                    onChange={(e) => setConfirmStart(e.target.checked ? b.id : '')}
                  />{' '}
                  已核对本批所有任务的账号、收件人、标题与正文，确认真实发送
                </label>
                <button
                  className="button primary"
                  disabled={busy || confirmStart !== b.id}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api('/report-batches/' + b.id + '/start', {
                        method: 'POST',
                        body: { confirmLive: true },
                      });
                      setConfirmStart('');
                      await refresh();
                    } catch (e) {
                      setError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  启动整个批次
                </button>
              </div>
            )}
            {b.reports.length === 0 && (
              <p>
                {b.emailReports === false
                  ? '本批次不发送自动报告邮件，发送结果与异常请在平台查看。'
                  : '批次统一统计原始任务和补发。异常会单独通知，未完成每30分钟发送进度，结束后发送最终报告。'}
              </p>
            )}
            {b.reports.map((r) => (
              <div key={r.id} style={{ borderTop: '1px solid #d9e3f3', padding: '16px 0' }}>
                <strong>
                  {r.correctionOf
                    ? '核查更正报告'
                    : r.kind === 'progress'
                      ? '进度与异常通知'
                      : r.kind === 'execution'
                        ? `执行报告${r.revision ? ' · 修订 ' + r.revision : ''}`
                        : b.sample
                          ? '历史核查报告样例'
                          : '12小时核查报告'}
                </strong>
                {r.correctedBy && <p>此报告已更正，请以核查更正报告为准。</p>}
                <p>
                  {r.deliveries
                    .map(
                      (d) =>
                        `${d.email}：${labels[d.status] || d.status}${d.error ? '（' + d.error + '）' : ''}`,
                    )
                    .join('；')}
                </p>
                <a
                  className="button"
                  target="_blank"
                  rel="noreferrer"
                  href={'/api/batch-reports/' + encodeURIComponent(r.id)}
                >
                  查看固定格式原文
                </a>
                {r.deliveries.some((d) => ['failed', 'needs_review'].includes(d.status)) && (
                  <button
                    className="button"
                    onClick={async () => {
                      try {
                        if (
                          r.deliveries.some((d) => d.status === 'needs_review') &&
                          !window.confirm('请核对报告是否已收到，确认重发可能产生重复邮件。')
                        )
                          return;
                        await api('/batch-reports/' + encodeURIComponent(r.id) + '/retry', {
                          method: 'POST',
                          body: { confirmUncertain: true },
                        });
                        refresh();
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    确认重试报告
                  </button>
                )}
              </div>
            ))}
          </section>
        ))}
    </>
  );
}
