import React, { useEffect, useState } from 'react';
import { unscheduledLists } from './unscheduled.js';
import PaginatedResults from './PaginatedResults.jsx';
export default function Unscheduled({ state, api, active, query, onCount, onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const signature = JSON.stringify([
    state.lists.map((l) => [l.id, l.count]),
    state.campaigns.map((c) => [c.id, c.status, c.listId]),
  ]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setError('');
    setData(null);
    onCount(null);
    // Only load the backlog when visible. Bound concurrency to avoid flooding
    // the browser and server with a request for every historical campaign.
    const paths = [
      ...state.lists.map((l) => '/lists/' + l.id),
      ...state.campaigns.map((c) => '/campaigns/' + c.id),
    ];
    const results = new Array(paths.length);
    let next = 0;
    Promise.all(
      Array.from({ length: Math.min(4, paths.length) }, async () => {
        while (current && next < paths.length) {
          const index = next++;
          results[index] = await api(paths[index]);
        }
      }),
    )
      .then(() => {
        if (!current) return;
        const lists = results.slice(0, state.lists.length);
        const campaigns = results.slice(state.lists.length);
        const result = unscheduledLists(lists, campaigns);
        setData(result);
        onCount(result.reduce((n, l) => n + l.contacts.length, 0));
      })
      .catch((e) => {
        if (current) {
          setError(e.message);
          current = false;
        }
      });
    return () => {
      current = false;
    };
  }, [active, signature, retry]);
  if (!active) return null;
  if (error)
    return (
      <div className="info-strip" role="alert">
        未排期核对失败：{error}
        <button className="text-button" onClick={() => setRetry((n) => n + 1)}>
          重试
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="info-strip" role="status">
        正在核对导入邮件与已有任务…
      </div>
    );
  const visible = data.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <div className="info-strip">
        已导入但尚未分配到真实发送任务的邮件；已进入草稿、排期或发送记录的相同邮件不会重复计入。
      </div>
      {visible.length ? (
        <PaginatedResults key={query} items={visible} label="组批量任务">
          {(pageItems) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>批量任务</th>
                    <th>未排期邮件</th>
                    <th>状态</th>
                    <th>导入时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <button className="text-button task-name" onClick={() => onOpen(l)}>
                          {l.name}
                        </button>
                      </td>
                      <td>
                        {l.contacts.length}
                        <small>封待安排</small>
                      </td>
                      <td>
                        <span className="count-label">未排期</span>
                      </td>
                      <td>
                        {new Date(l.createdAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })}
                      </td>
                      <td>
                        <button className="text-button" onClick={() => onOpen(l)}>
                          查看待安排明细 →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PaginatedResults>
      ) : (
        <div className="info-strip">
          {query ? '没有匹配的未排期任务。' : '没有遗漏的未排期邮件。'}
        </div>
      )}
    </>
  );
}
