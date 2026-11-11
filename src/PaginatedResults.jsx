import React, { useState } from 'react';

export default function PaginatedResults({ items, children, label = '条任务' }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  return (
    <>
      {children(items.slice(start, start + pageSize))}
      <nav className="task-pagination" aria-label="任务列表分页">
        <span>
          共 {items.length} {label} · 当前 {items.length ? start + 1 : 0}–
          {Math.min(start + pageSize, items.length)}
        </span>
        <label>
          每页
          <select
            aria-label="每页任务数"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button className="button" disabled={current === 1} onClick={() => setPage(1)}>
          首页
        </button>
        <button className="button" disabled={current === 1} onClick={() => setPage(current - 1)}>
          上一页
        </button>
        <span aria-live="polite">
          {current} / {pages}
        </span>
        <button
          className="button"
          disabled={current === pages}
          onClick={() => setPage(current + 1)}
        >
          下一页
        </button>
        <button className="button" disabled={current === pages} onClick={() => setPage(pages)}>
          末页
        </button>
      </nav>
    </>
  );
}
