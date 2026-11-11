import React, { useEffect, useState } from 'react';
import './import-tasks.css';
const waiting = (c) => (c.unassigned || 0) + (c.pending || 0) + (c.running || 0) + (c.retry || 0);
const labels = {
  unverified: '历史安排待核实',
  unassigned: '未排期',
  pending: '待执行',
  scheduled: '已预约',
  running: '执行中',
  retry: '等待重试',
  uncertain: '待核对',
  sent: '已发送',
  failed: '发送失败（含退信）',
  cancelled: '已取消',
};
export default function ImportTasks({
  api,
  compact = false,
  onFollowup,
  onCampaign,
  onReports,
  onFilter,
  selectedId = '',
  accounts = [],
}) {
  const [dateType, setDateType] = useState('import'),
    [detailTab, setDetailTab] = useState('messages');
  const [account, setAccount] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [taskState, setTaskState] = useState('');
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState(selectedId),
    [detail, setDetail] = useState(null),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [offset, setOffset] = useState(0),
    [status, setStatus] = useState(''),
    [saving, setSaving] = useState(false);
  async function load() {
    const d = await api('/import-tasks');
    setData(d);
  }
  useEffect(() => {
    let active = true;
    const poll = () =>
      api('/import-tasks')
        .then((d) => {
          if (active) setData(d);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    poll();
    const timer = setInterval(poll, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let active = true;
    api(`/import-tasks/${encodeURIComponent(selected)}?offset=${offset}&status=${status}`)
      .then((d) => {
        if (active) {
          setDetail(d);
          setName(d.task.name);
          setDescription(d.task.description || '');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [selected, offset, status]);
  function choose(id) {
    setSelected(id);
    setOffset(0);
    setStatus('');
    onFilter?.(id);
  }
  const items = (data?.items || []).filter(
    (t) =>
      `${t.name} ${t.sourceFileName || ''}`.toLowerCase().includes(query.toLowerCase()) &&
      (!account || t.accountIds?.includes(account)) &&
      ((!from && !to) ||
        (dateType === 'import'
          ? t.createdAt
            ? [new Date(Date.parse(t.createdAt) + 8 * 3600000).toISOString().slice(0, 10)]
            : []
          : dateType === 'scheduled'
            ? t.scheduledDays || []
            : t.sentDays || []
        ).some((day) => (!from || day >= from) && (!to || day <= to))) &&
      (!taskState || (taskState === 'complete' ? t.complete : t.counts[taskState] > 0)),
  );
  const tasks = items.filter(
    (t) => t.origin !== 'unknown' && (!selected || compact || t.id === selected),
  );
  const cards = [
    ['导入任务', tasks.length],
    ['发送完成任务', tasks.filter((t) => t.complete).length],
    ['含失败任务', tasks.filter((t) => t.counts.failed).length],
    ['已处理记录的任务', tasks.filter((t) => t.counts.handled).length],
    ['收到回复的任务', tasks.filter((t) => t.counts.receivedReplies).length],
    ['已回复跟进任务', tasks.filter((t) => t.counts.replied).length],
    ['待回复跟进任务', tasks.filter((t) => t.counts.awaitingReply).length],
  ];
  if (compact) {
    const sum = (key) => tasks.reduce((n, t) => n + (t.counts[key] || 0), 0);
    const totals = [
      ['平台绑定账号', accounts.length, `已启用 ${accounts.filter((a) => !a.disabled).length} 个`],
      ['导入任务', tasks.length, '业务导入任务，不含执行子任务'],
      [
        '待发送邮件',
        tasks.reduce((n, t) => n + waiting(t.counts), 0),
        `未排期 ${sum('unassigned')} · 已预约 ${sum('scheduled')} · 其他待发（含暂停） ${sum('pending') + sum('running') + sum('retry') - sum('scheduled')}`,
      ],
      ['已发送邮件', sum('sent'), '发送服务已接受，不代表进入收件箱'],
      ['发送失败', sum('failed'), '含确认退信，与已发送可能交叉'],
      ['收到回复', sum('receivedReplies'), '按导入任务累计回复会话'],
    ];
    return (
      <section className="import-workspace">
        {error && <div className="warning-box">{error}</div>}
        <div className="import-metrics">
          {totals.map(([label, value, desc]) => (
            <div className="panel" key={label}>
              <span>{label}</span>
              <strong>{data ? value : '—'}</strong>
              <small>{desc}</small>
            </div>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="import-workspace">
      {error && (
        <div className="warning-box" role="alert">
          {error}
        </div>
      )}
      <div className="import-metrics">
        {cards.map(([label, value]) => (
          <div className="panel" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>个任务 · 指标可交叉</small>
          </div>
        ))}
      </div>
      {!compact && (
        <div className="toolbar import-task-filters">
          <select
            aria-label="选择导入任务"
            value={selected}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">全部导入任务</option>
            {data?.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            aria-label="导入任务账号"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">全部账号</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.from || a.name}
              </option>
            ))}
          </select>
          <select
            aria-label="导入任务状态"
            value={taskState}
            onChange={(e) => setTaskState(e.target.value)}
          >
            <option value="">全部状态</option>
            <option value="complete">发送完成</option>
            <option value="failed">含失败</option>
            <option value="unassigned">含未排期</option>
            <option value="pending">含待执行</option>
            <option value="awaitingReply">待回复跟进</option>
          </select>
          <select
            aria-label="任务日期类型"
            value={dateType}
            onChange={(e) => setDateType(e.target.value)}
          >
            <option value="import">导入日期</option>
            <option value="scheduled">预约日期</option>
            <option value="sent">提交发送日期</option>
          </select>
          <label>
            日期从
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            至<input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      )}
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>{compact ? '最近的导入任务' : '导入任务'}</h2>
            <p>围绕一次业务导入查看发送和跟进。筛选命中的任务展示累计统计。</p>
          </div>
          {!compact && (
            <input
              aria-label="搜索导入任务"
              placeholder="搜索任务名称或原文件"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
        </div>
        {!data ? (
          <p className="import-note">正在读取任务统计…</p>
        ) : (
          <div className="table-wrap">
            <table className="import-table">
              <thead>
                <tr>
                  <th>任务名称 / 来源</th>
                  <th>有效邮件</th>
                  <th>待发送</th>
                  <th>已发送</th>
                  <th>发送失败</th>
                  <th>收到回复</th>
                </tr>
              </thead>
              <tbody>
                {(compact
                  ? [
                      ...items.filter((t) => t.origin !== 'unknown').slice(0, 4),
                      ...items.filter((t) => t.origin === 'unknown'),
                    ]
                  : items.filter((t) => !selected || t.id === selected)
                ).map((t) => (
                  <tr key={t.id} className={selected === t.id ? 'import-selected' : ''}>
                    <td>
                      <button className="text-button" onClick={() => choose(t.id)}>
                        {t.name}
                      </button>
                      <small>
                        {t.origin === 'unknown'
                          ? '归属待确认，不计入导入任务总数'
                          : t.sourceFileName || '原文件名未记录'}
                        {t.complete ? ' · 发送完成' : ''}
                      </small>
                    </td>
                    <td>{t.counts.total} 封</td>
                    <td>{waiting(t.counts)} 封</td>
                    <td>{t.counts.sent} 封</td>
                    <td>{t.counts.failed} 封</td>
                    <td>{t.counts.receivedReplies} 会话</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="import-note">
          已发送表示发送服务接受，不代表进入收件箱；发送失败包含退信，与已发送可能交叉。回复按系统分类和会话引用统计；同步不完整时可能低估。统计时间：
          {data?.at ? new Date(data.at).toLocaleString('zh-CN') : '—'}
        </p>
      </section>
      {detail && selected && (
        <section className="panel import-detail">
          <div className="section-heading">
            <div>
              <h2>{detail.task.name}</h2>
              <p>
                {detail.task.sourceFileName || '原文件名未记录'} {detail.task.sheetName || ''}
              </p>
            </div>
            <button className="button" onClick={() => choose('')}>
              关闭详情
            </button>
          </div>
          {detail.task.origin !== 'unknown' && (
            <div className="import-edit">
              <label>
                任务名称（说明用途）
                <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                用途说明
                <textarea
                  value={description}
                  maxLength={500}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <button
                className="button"
                disabled={saving || !name.trim()}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await api('/import-tasks/' + selected, {
                      method: 'PATCH',
                      body: { name, description },
                    });
                    await load();
                    setDetail((d) => ({ ...d, task: { ...d.task, name, description } }));
                  } catch (e) {
                    setError(e.message);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                保存任务信息
              </button>
            </div>
          )}
          <div className="import-detail-summary">
            <span>历史安排待核实：{detail.task.counts.unverified} 封</span>
            <span>收到回复：{detail.task.counts.receivedReplies} 会话</span>
            <span>已回复：{detail.task.counts.replied} 会话</span>
            <span>已处理：{detail.task.counts.handled} 条记录</span>
            <span>待处理：{detail.task.counts.pendingHandling} 条记录</span>
            <span>无需回复：{detail.task.counts.noReply}</span>

            <button className="text-button" onClick={() => onFollowup?.(selected)}>
              查看回复与跟进 →
            </button>
          </div>
          <div className="import-view-toggle">
            <button className="button" onClick={() => setDetailTab('messages')}>
              发送明细
            </button>
            <button className="button" onClick={() => onFollowup?.(selected)}>
              回复与跟进 ↗
            </button>
            <button className="button" onClick={() => setDetailTab('children')}>
              执行子任务
            </button>
            <button className="button" onClick={() => onReports?.(selected)}>
              报告 ↗
            </button>
          </div>
          <div hidden={detailTab !== 'children'}>
            <details open>
              <summary>执行子任务（{detail.task.campaignIds.length}）</summary>
              <div className="import-child-list">
                {detail.task.campaignIds.map((id) => (
                  <button className="button" key={id} onClick={() => onCampaign?.(id)}>
                    {id}
                  </button>
                ))}
              </div>
            </details>
          </div>
          <div hidden={detailTab !== 'messages'}>
            <div className="toolbar">
              <h3>逻辑邮件明细</h3>
              <select
                aria-label="逻辑邮件状态"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">全部状态</option>
                {Object.entries(labels).map(([k, v]) => (
                  <option value={k} key={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="table-wrap">
              <table className="import-table">
                <thead>
                  <tr>
                    <th>来源记录</th>
                    <th>最终状态</th>
                    <th>发送尝试</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.records.map((r) => (
                    <tr key={r.id}>
                      <td className="import-id">
                        {r.email || r.id}
                        <small>{r.id}</small>
                      </td>
                      <td>
                        {labels[r.status]}
                        {r.bounced ? ' · 已退信' : ''}
                      </td>
                      <td>{r.attempts.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="toolbar">
              <button
                className="button"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              >
                上一页
              </button>
              <span>
                共 {detail.total} 条 · 第 {Math.floor(offset / 100) + 1} 页
              </span>
              <button
                className="button"
                disabled={offset + 100 >= detail.total}
                onClick={() => setOffset(offset + 100)}
              >
                下一页
              </button>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
