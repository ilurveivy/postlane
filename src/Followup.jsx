import React, { useEffect, useState } from 'react';
import { filterFollowup, followupTypes as types } from './followup-filter.js';
const when = (v) =>
  v
    ? new Date(v).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '尚未同步';
export default function Followup({
  api,
  importTasks = [],
  importTaskId = '',
  onImportTaskChange,
  campaigns,
  onOpen,
  onOpenThread,
  refresh,
  initialCampaign = '',
  initialView,
  onViewChange,
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [bulkResult, setBulkResult] = useState('');
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [kind, setKind] = useState(initialView?.kind ?? 'reply'),
    [account, setAccount] = useState(initialView?.account ?? ''),
    [campaign, setCampaign] = useState(initialView?.campaign ?? initialCampaign),
    [handled, setHandled] = useState(initialView?.handled ?? 'pending'),
    [query, setQuery] = useState(initialView?.query ?? ''),
    [selected, setSelected] = useState(initialView?.selected ?? null),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState(initialView?.tab ?? 'messages');
  useEffect(() => {
    onViewChange?.({ kind, account, campaign, handled, query, selected, tab });
  }, [kind, account, campaign, handled, query, selected, tab, onViewChange]);
  async function load() {
    setData(await api('/followup'));
  }
  useEffect(() => {
    let active = true;
    const poll = () =>
      api('/followup')
        .then((d) => {
          if (active) setData(d);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);
  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const filters = { account, campaign, handled, kind, query, importTaskId };
  const scope = filterFollowup(data?.events || [], {
    account,
    campaign,
    query,
    importTaskId,
  });
  useEffect(() => {
    setPageIndex(0);
  }, [account, campaign, handled, kind, query, importTaskId]);
  const rows = filterFollowup(data?.events || [], filters);
  const pendingRows = rows.filter((e) => !e.handled);
  const event = rows.find((e) => e.id === selected);
  const exportUrl = '/api/followup/export?' + new URLSearchParams(filters).toString();
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">AFTER SEND</div>
          <h1>回复与跟进</h1>
          <p>发送结束，沟通继续。新回复和投递异常会持续回到这里。</p>
        </div>
        <div className="follow-actions">
          <button
            className="button"
            disabled={busy || !pendingRows.length}
            onClick={() =>
              run(async () => {
                const result = await api('/followup/mark-handled', {
                  method: 'POST',
                  body: { filters, ids: pendingRows.map((e) => e.id) },
                });
                setBulkResult(
                  `已将当前筛选的 ${result.updated} 条待处理记录标记为已处理${result.skipped ? `，${result.skipped} 条因状态变化跳过` : ''}。未发送邮件。`,
                );
              })
            }
          >
            筛选待处理全部标记已处理（{pendingRows.length} 条）
          </button>
          <a className="button" href={exportUrl} download>
            导出筛选结果
          </a>
          <a className="button" href="/api/followup/export" download>
            导出全部
          </a>
          <button
            className="button primary"
            disabled={busy || data?.running}
            onClick={() =>
              run(() =>
                api('/followup/sync', {
                  method: 'POST',
                  body: account ? { accountId: account } : {},
                }),
              )
            }
          >
            {data?.running ? '正在同步邮箱…' : '立即同步'}
          </button>
        </div>
      </div>
      {bulkResult && (
        <div className="warning-box" role="status">
          {bulkResult}
        </div>
      )}
      <p className="import-note">
        批量处理覆盖当前筛选的全部页，仅修改处理状态；收到回复和已回复按实际邮件独立统计。
      </p>
      {data?.accounts.some((a) => a.status === 'error') && (
        <div className="warning-box" role="status">
          部分账号同步失败，请在「持续跟踪与同步」查看原因。已有记录仍可查看。
        </div>
      )}
      {error && (
        <div className="warning-box" role="alert">
          {error}
        </div>
      )}
      <div className="follow-stats">
        {['reply', 'bounce', 'archive_reply'].map((t) => (
          <button
            key={t}
            className="panel follow-stat"
            onClick={() => {
              setKind(t);
              setHandled('all');
              setTab('messages');
            }}
          >
            <span>{types[t]}</span>
            <strong>{scope.filter((e) => e.type === t).length || 0}</strong>
            <small>{t === 'archive_reply' ? '单独记录，不计入外部回复' : '点击查看全部记录'}</small>
          </button>
        ))}
        <button
          className="panel follow-stat"
          onClick={() => {
            setKind('reply');
            setHandled('pending');
            setTab('messages');
          }}
        >
          <span>待处理</span>
          <strong>{filterFollowup(scope, { handled: 'pending', kind: 'reply' }).length}</strong>
          <small>用户回复需要处理</small>
        </button>
      </div>
      <div className="follow-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'messages'} onClick={() => setTab('messages')}>
          邮件动态
        </button>
        <button role="tab" aria-selected={tab === 'tracking'} onClick={() => setTab('tracking')}>
          持续跟踪与同步
        </button>
      </div>
      {!data ? (
        <section className="panel follow-empty">正在读取跟进记录…</section>
      ) : tab === 'messages' ? (
        <>
          <div className="toolbar follow-filters">
            <select aria-label="动态类型" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="actionable">回复与异常</option>
              <option value="all">全部类型</option>
              {Object.entries(types).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select
              aria-label="处理状态"
              value={handled}
              onChange={(e) => setHandled(e.target.value)}
            >
              <option value="pending">待处理</option>
              <option value="all">全部处理状态</option>
              <option value="done">已处理</option>
            </select>
            <select
              aria-label="导入任务"
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
            <select
              aria-label="发件账号"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">全部账号</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
            <select
              aria-label="关联任务"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
            >
              <option value="">全部执行子任务</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              aria-label="搜索回复"
              placeholder="搜索邮箱、主题或正文"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="toolbar">
            <span>
              共 {rows.length} 条邮件事件 · 第 {pageIndex + 1} 页
            </span>
            <button
              className="button"
              disabled={!pageIndex}
              onClick={() => setPageIndex((p) => p - 1)}
            >
              上一页
            </button>
            <button
              className="button"
              disabled={(pageIndex + 1) * 100 >= rows.length}
              onClick={() => setPageIndex((p) => p + 1)}
            >
              下一页
            </button>
          </div>
          <div className="follow-layout">
            <section className="panel follow-list" aria-label="邮件动态列表">
              {!rows.length && (
                <div className="follow-empty">
                  <h3>{data.running ? '正在查找相关邮件' : '当前筛选下没有记录'}</h3>
                  <p>新回复可能几天后到达，跟踪会按设置继续。</p>
                </div>
              )}
              {rows.slice(pageIndex * 100, (pageIndex + 1) * 100).map((e) => (
                <button
                  key={e.id}
                  className={'follow-row ' + (selected === e.id ? 'selected' : '')}
                  onClick={() => setSelected(e.id)}
                >
                  <div className="follow-row-top">
                    <span className={'follow-kind ' + e.type}>{types[e.type]}</span>
                    <time>{when(e.date)}</time>
                  </div>
                  <strong>{e.from.join(', ')}</strong>
                  <span>{e.subject || '无标题'}</span>
                  <small>
                    {e.accountEmail} · {e.handled ? '已处理' : '待处理'} ·{' '}
                    {{
                      replied: '已回复跟进',
                      awaitingReply: '待回复跟进',
                      noReply: '无需回复',
                      legacyHandled: '历史已处理',
                    }[e.followupStatus] || (e.handled ? '已处理' : '待处理')}
                  </small>
                </button>
              ))}
            </section>
            <section className="panel follow-reader" aria-label="邮件详情">
              {!event ? (
                <div className="follow-empty">
                  <h3>选择一封邮件</h3>
                  <p>查看内容、关联任务和处理状态。</p>
                </div>
              ) : (
                <>
                  <div className="follow-row-top">
                    <span className={'follow-kind ' + event.type}>{types[event.type]}</span>
                    <span>{when(event.date)}</span>
                  </div>
                  <h2>{event.subject || '无标题'}</h2>
                  <p className="muted">
                    {event.from.join(', ')} → {event.accountEmail}
                  </p>
                  <div className="follow-actions">
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          api('/followup/events/' + event.id, {
                            method: 'PATCH',
                            body: {
                              handled: !event.handled,
                            },
                          }),
                        )
                      }
                    >
                      {event.handled ? '恢复待处理' : '标记已处理'}
                    </button>
                    {event.type === 'reply' && (
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            api('/followup/events/' + event.id, {
                              method: 'PATCH',
                              body: {
                                handled: true,
                                disposition:
                                  event.followupDisposition === 'no_reply' ? 'pending' : 'no_reply',
                              },
                            }),
                          )
                        }
                      >
                        {event.followupDisposition === 'no_reply' ? '恢复需要回复' : '无需回复'}
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => onOpenThread(event.id)}
                    >
                      查看完整会话
                    </button>
                  </div>
                  <p>
                    导入任务：
                    {event.importTaskIds
                      ?.map((id) => importTasks.find((t) => t.id === id)?.name || '历史未归属')
                      .join('、')}
                  </p>
                  <div className="follow-links">
                    {[...new Set(event.links.map((l) => l.campaignId))].map((id) => (
                      <button
                        key={id}
                        onClick={() => onOpen(campaigns.find((c) => c.id === id) || { id })}
                      >
                        {campaigns.find((c) => c.id === id)?.name || '关联任务'} ↗
                      </button>
                    ))}
                  </div>
                  {event.type === 'bounce' && (
                    <div className="warning-box">
                      收到退信通知。已发送记录不代表成功送达；地址不存在的永久退信会阻止再次发送。
                    </div>
                  )}
                  <pre className="follow-body">
                    {event.text || '此记录暂无正文，可在平台内查看完整会话或同步邮箱后重试。'}
                  </pre>
                </>
              )}
            </section>
          </div>
        </>
      ) : (
        <>
          <section className="panel follow-help">
            <h3>发送结束后，默认继续跟踪 14 天</h3>
            <p>
              自动同步间隔为 {data?.intervalMinutes ?? 60} 分钟，服务启动后首次等待 1
              小时。你可以为任务延长 14
              天或暂停跟踪。电脑与服务需要运行；恢复后自动补查跟踪期内的新邮件。新回复以侧栏数字和页面提示通知，只有新增待处理内容才提示。
            </p>
            <p>
              目前支持已绑定的 Gmail SMTP
              账号，使用相同应用密码只读访问邮箱。不会发送回复、删除邮件或改变 Gmail 已读状态。
            </p>
          </section>
          <section className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>同步状态</th>
                  <th>上次成功同步</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.email}</td>
                    <td>
                      {!a.supported
                        ? '暂不支持'
                        : a.status === 'syncing'
                          ? '同步中'
                          : a.status === 'error'
                            ? '同步异常'
                            : '就绪'}
                    </td>
                    <td>{when(a.lastSyncAt)}</td>
                    <td className="result-note">
                      {a.error ||
                        (!a.supported
                          ? '当前仅支持 Gmail SMTP'
                          : '只读检查已发送、收件箱、草稿、垃圾邮件及归档')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel table-wrap follow-tracking">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>跟踪状态</th>
                  <th>截止时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.tracking.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>
                      {!t.supported
                        ? '暂不支持'
                        : !t.enabled
                          ? '已暂停'
                          : !t.until
                            ? '发送后开始'
                            : Date.parse(t.until) < Date.now()
                              ? '已到期'
                              : '跟踪中'}
                    </td>
                    <td>{t.until ? when(t.until) : '发送后 14 天'}</td>
                    <td>
                      <div className="follow-actions">
                        <button
                          className="button"
                          disabled={busy || !t.supported}
                          onClick={() =>
                            run(() =>
                              api('/campaigns/' + t.id + '/tracking', {
                                method: 'PUT',
                                body: { enabled: true, days: 14 },
                              }),
                            )
                          }
                        >
                          从现在延长 14 天
                        </button>
                        <button
                          className="button"
                          disabled={busy || !t.supported}
                          onClick={() =>
                            run(() =>
                              api('/campaigns/' + t.id + '/tracking', {
                                method: 'PUT',
                                body: { enabled: !t.enabled },
                              }),
                            )
                          }
                        >
                          {t.enabled ? '暂停跟踪' : '恢复跟踪'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}
