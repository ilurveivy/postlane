import React, { useEffect, useRef, useState } from 'react';
import {
  Tray,
  PaperPlaneTilt,
  NotePencil,
  WarningCircle,
  Trash,
  Archive,
  MagnifyingGlass,
  ArrowsClockwise,
  Plus,
  ArrowBendUpLeft,
  EnvelopeSimple,
  EnvelopeOpen,
  Sparkle,
  FloppyDisk,
  X,
  ArrowLeft,
  Paperclip,
  CheckCircle,
  Clock,
} from '@phosphor-icons/react';
import './inbox.css';
const folders = [
  ['inbox', '收件箱', Tray],
  ['sent', '已发送', PaperPlaneTilt],
  ['drafts', '草稿箱', NotePencil],
  ['failed', '发送异常', WarningCircle],
  ['junk', '垃圾邮件', Archive],
  ['remote-drafts', '邮箱草稿', NotePencil],
  ['trash', '已删除', Trash],
];
const date = (s) =>
  new Date(s).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
const labels = {
  draft: '草稿',
  queued: '等待发送',
  sending: '正在提交',
  sent: 'SMTP已接受',
  failed: '发送失败',
  uncertain: '结果待确认',
  needs_review: '需人工核对',
};
export default function Inbox({ api, initialTarget, onBackToFollowup }) {
  const [focusMessageId, setFocusMessageId] = useState(null),
    [targetError, setTargetError] = useState(''),
    [targetLoading, setTargetLoading] = useState(false),
    [targetRetry, setTargetRetry] = useState(0);
  const [data, setData] = useState({ threads: [], drafts: [], accounts: [], counts: {}, sync: [] }),
    [account, setAccount] = useState('all'),
    [folder, setFolder] = useState('inbox'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [q, setQ] = useState(''),
    [unread, setUnread] = useState(false),
    [offset, setOffset] = useState(0),
    [loading, setLoading] = useState(true);
  const [thread, setThread] = useState(null),
    [draft, setDraft] = useState(null),
    [body, setBody] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [dirty, setDirty] = useState(false),
    [suggestion, setSuggestion] = useState(''),
    [showAI, setShowAI] = useState(false),
    [rules, setRules] = useState('');
  const draftRef = useRef(null),
    bodyRef = useRef(''),
    editing = useRef(false),
    saving = useRef(false),
    pendingSave = useRef(null),
    selection = useRef(0),
    editRevision = useRef(0),
    pendingReads = useRef(new Set()),
    mounted = useRef(true);
  const url =
    '/inbox?' +
    new URLSearchParams({
      accountId: account,
      folder: ['drafts', 'failed'].includes(folder) ? 'all' : folder,
      from,
      to,
      q,
      unread: String(unread),
      offset: String(offset),
    });
  const refresh = async () => {
    const d = await api(url);
    setData(d);
    setLoading(false);
    return d;
  };
  useEffect(() => {
    let alive = true;
    const load = () =>
      api(url)
        .then((d) => {
          if (alive) {
            setData(d);
            setLoading(false);
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    setLoading(true);
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);
  const updateDraft = (d) => {
    draftRef.current = d;
    setDraft(d);
  };
  const markEdited = () => {
    editRevision.current++;
    editing.current = true;
    setDirty(true);
  };
  const saveDraft = async (force = false) => {
    const d = draftRef.current;
    if (!d || (!force && !editing.current && d.status !== 'new')) return d;
    if (d.status === 'new' && !force && !editing.current && !d.to && !d.subject && !bodyRef.current)
      return d;
    if (saving.current) throw Error('草稿正在保存，请稍候');
    saving.current = true;
    const revision = editRevision.current,
      text = bodyRef.current;
    try {
      const saved = await api('/inbox/drafts', { method: 'POST', body: { ...d, body: text } });
      if (revision === editRevision.current) {
        updateDraft(saved);
        editing.current = false;
        setDirty(false);
      } else {
        updateDraft({
          ...saved,
          ...draftRef.current,
          id: saved.id,
          version: saved.version,
          status: 'draft',
        });
      }
      return saved;
    } finally {
      saving.current = false;
    }
  };
  const save = async (force = false) => {
    while (pendingSave.current) await pendingSave.current;
    const pending = saveDraft(force);
    pendingSave.current = pending;
    try {
      return await pending;
    } finally {
      if (pendingSave.current === pending) pendingSave.current = null;
    }
  };
  const closeEditor = (leaveThread = false) =>
    safely(async () => {
      selection.current++;
      let saved;
      do {
        saved = await save();
      } while (editing.current);
      updateDraft(null);
      bodyRef.current = '';
      setBody('');
      setDirty(false);
      setSuggestion('');
      setShowAI(false);
      if (leaveThread) setThread(null);
      if (saved?.id && ['draft', 'failed'].includes(saved.status)) {
        setNotice('草稿已保存，可在草稿箱继续编辑');
        await refresh();
      }
    });
  useEffect(() => {
    if (!dirty || !draft) return;
    const timer = setTimeout(() => save().catch((e) => setError(e.message)), 1000);
    return () => clearTimeout(timer);
  }, [body, dirty, draft?.id, draft?.to, draft?.subject, draft?.accountId, draft?.version]);
  useEffect(() => {
    const f = (e) => {
      if (
        editing.current ||
        (draftRef.current?.status === 'new' &&
          (draftRef.current.to || draftRef.current.subject || bodyRef.current))
      ) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const leave = (e) => {
      if (
        editing.current ||
        saving.current ||
        (draftRef.current?.status === 'new' &&
          (draftRef.current.to || draftRef.current.subject || bodyRef.current))
      ) {
        e.preventDefault();
        setError('请先保存草稿或删除草稿，再离开邮箱。');
      }
    };
    window.addEventListener('postlane-leave-inbox', leave);
    window.addEventListener('beforeunload', f);
    return () => {
      window.removeEventListener('beforeunload', f);
      window.removeEventListener('postlane-leave-inbox', leave);
    };
  }, []);
  const safely = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selection.current++;
    };
  }, []);
  const syncReadInBackground = (full, serial) => {
    if (pendingReads.current.has(full.id)) return;
    pendingReads.current.add(full.id);
    // Reading cached mail must never wait for an IMAP login/flag update.
    void api('/inbox/threads/' + full.id + '/read', {
      method: 'PATCH',
      body: { seen: true },
    })
      .then(() => {
        if (!mounted.current) return;
        setData((current) => ({
          ...current,
          threads: current.threads.map((t) => (t.id === full.id ? { ...t, unread: false } : t)),
        }));
      })
      .catch((e) => {
        if (mounted.current && selection.current === serial)
          setNotice('邮件已打开；已读标记未同步：' + e.message);
      })
      .finally(() => pendingReads.current.delete(full.id));
  };
  const open = async (t) =>
    safely(async () => {
      await save();
      const serial = ++selection.current;
      const full = await api('/inbox/threads/' + t.id);
      if (serial !== selection.current) return;
      setThread(full);
      setFocusMessageId(null);
      updateDraft(null);
      setBody('');
      bodyRef.current = '';
      setSuggestion('');
      setShowAI(false);
      setNotice('');
      if (full.unread) syncReadInBackground(full, serial);
    });
  useEffect(() => {
    if (!initialTarget) {
      setTargetLoading(false);
      setTargetError('');
      setFocusMessageId(null);
      return;
    }
    if (draftRef.current) {
      setTargetError('请先关闭当前草稿，再重试定位会话。');
      return;
    }
    let alive = true;
    const serial = ++selection.current;
    setTargetLoading(true);
    setTargetError('');
    api('/followup/events/' + encodeURIComponent(initialTarget.eventId) + '/thread')
      .then(({ thread: full, messageId }) => {
        if (!alive || serial !== selection.current) return;
        setAccount(full.accountId);
        setFolder(
          ['inbox', 'junk', 'trash', 'sent', 'remote-drafts'].find((f) =>
            full.folders.includes(f),
          ) || 'inbox',
        );
        setFrom('');
        setTo('');
        setQ('');
        setUnread(false);
        setOffset(0);
        setThread(full);
        setFocusMessageId(messageId);
        setNotice('已定位跟进记录对应的邮件，可在此查看往来并回复。');
        if (full.unread) syncReadInBackground(full, serial);
      })
      .catch((e) => {
        if (alive && serial === selection.current) setTargetError(e.message);
      })
      .finally(() => {
        if (alive) setTargetLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [initialTarget?.key, targetRetry]);
  useEffect(() => {
    if (focusMessageId)
      document
        .getElementById('mail-message-' + focusMessageId)
        ?.scrollIntoView({ block: 'nearest' });
  }, [focusMessageId, thread?.id]);
  const beginReply = () =>
    safely(async () => {
      if (!thread) return;
      selection.current++;
      await save();
      const current = await api('/inbox/threads/' + thread.id);
      setThread(current);
      const existing = data.drafts.find((d) => d.threadId === thread.id && d.status === 'draft');
      if (existing) {
        updateDraft(existing);
        setBody(existing.body);
        bodyRef.current = existing.body;
        return;
      }
      const d = await api('/inbox/drafts', {
        method: 'POST',
        body: { threadId: current.id, contextVersion: current.contextVersion, body: '' },
      });
      updateDraft(d);
      setBody('');
      bodyRef.current = '';
      setNotice('');
    });
  const openDraft = (d) =>
    safely(async () => {
      selection.current++;
      await save();
      updateDraft(d);
      setBody(d.body);
      bodyRef.current = d.body;
      editing.current = false;
      setDirty(false);
      setSuggestion('');
      setShowAI(false);
      setThread(d.threadId ? await api('/inbox/threads/' + d.threadId) : null);
      setNotice('');
    });
  const newMail = () =>
    safely(async () => {
      selection.current++;
      await save();
      setThread(null);
      const a =
        data.accounts.find((a) => a.defaultManualSender && !a.disabled) ||
        data.accounts.find((a) => a.id === account && !a.disabled) ||
        data.accounts.find((a) => !a.disabled);
      if (!a) throw Error('请先绑定Gmail发件账号');
      updateDraft({
        accountId: a.id,
        accountEmail: a.email,
        to: '',
        subject: '',
        body: '',
        status: 'new',
      });
      setBody('');
      bodyRef.current = '';
      setSuggestion('');
      setShowAI(false);
    });
  const persistNew = () => save(true);
  const onBody = (v) => {
    setBody(v);
    bodyRef.current = v;
    markEdited();
  };
  const send = () =>
    safely(async () => {
      const d = await persistNew();
      const result = await api('/inbox/drafts/' + d.id + '/send', {
        method: 'POST',
        body: { version: d.version, confirm: true },
      });
      updateDraft(result);
      setNotice('已加入发送队列。可在草稿箱查看进度，提交后进入已发送。');
      await refresh();
    });
  useEffect(() => {
    if (!draft?.id || !['queued', 'sending'].includes(draft.status)) return;
    const current = data.drafts.find((d) => d.id === draft.id);
    if (current) updateDraft(current);
  }, [data.drafts]);
  const read = () =>
    safely(async () => {
      await api('/inbox/threads/' + thread.id + '/read', {
        method: 'PATCH',
        body: { seen: false },
      });
      setNotice('已标记为未读');
      await refresh();
    });
  const generate = () =>
    safely(async () => {
      const d = await persistNew();
      const r = await api('/inbox/drafts/' + d.id + '/suggest', {
        method: 'POST',
        body: {},
      });
      if (draftRef.current?.id === d.id) setSuggestion(r.text);
    });
  const activeDrafts = data.drafts.filter((d) =>
    folder === 'failed'
      ? ['failed', 'uncertain', 'needs_review'].includes(d.status)
      : ['draft', 'queued', 'sending'].includes(d.status),
  );
  const editable = draft && ['draft', 'failed', 'new'].includes(draft.status);
  return (
    <div className="mail-workspace">
      {initialTarget && (
        <div className="mail-followup-context">
          <button className="button" onClick={onBackToFollowup}>
            <ArrowLeft size={17} />
            返回回复与跟进
          </button>
          {targetLoading && <span role="status">正在定位对应会话…</span>}
          {targetError && (
            <div role="alert">
              {targetError}{' '}
              <button
                className="button"
                disabled={targetLoading}
                onClick={() => setTargetRetry((n) => n + 1)}
              >
                重试定位
              </button>
            </div>
          )}
        </div>
      )}
      <header className="mail-heading">
        <div>
          <span className="mail-eyebrow">POSTLANE / MAIL</span>
          <h1>邮箱</h1>
          <p>让每一次回复，都接得上上一句。</p>
        </div>
        <button className="button primary" onClick={newMail} disabled={busy || targetLoading}>
          <Plus size={17} /> 写邮件
        </button>
      </header>
      <div className="mail-filters">
        <label>
          <span>日期范围</span>
          <select
            aria-label="日期范围"
            value={!from && !to ? 'all' : 'custom'}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'all') {
                setFrom('');
                setTo('');
              } else if (v !== 'custom') {
                const end = new Date();
                const start = new Date(end);
                if (v === 'week') start.setDate(start.getDate() - 6);
                const day = (d) =>
                  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
                setFrom(day(start));
                setTo(day(end));
              }
              setOffset(0);
            }}
          >
            <option value="all">全部日期</option>
            <option value="today">今天</option>
            <option value="week">最近7天</option>
            <option value="custom">自定义日期</option>
          </select>
        </label>
        <label>
          <span>邮箱账号</span>
          <select
            aria-label="邮箱账号"
            value={account}
            onChange={(e) => {
              setAccount(e.target.value);
              setOffset(0);
            }}
          >
            <option value="all">全部账号</option>
            {data.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>开始日期</span>
          <input
            aria-label="开始日期"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <span className="mail-date-sep">—</span>
        <label>
          <span>结束日期</span>
          <input
            aria-label="结束日期"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <button
          className="mail-link"
          onClick={() => {
            setFrom('');
            setTo('');
          }}
        >
          全部日期
        </button>
        <button
          className="button"
          disabled={busy || data.running}
          onClick={() =>
            safely(async () => {
              await api('/inbox/sync', {
                method: 'POST',
                body: account === 'all' ? {} : { accountId: account },
              });
              setNotice('正在同步 2026 年 9 月 10 日及之后的邮件。');
              await refresh();
            })
          }
        >
          <ArrowsClockwise size={16} className={data.running ? 'mail-spin' : ''} />
          {data.running ? '同步中' : '同步邮件'}
        </button>
      </div>
      {error && (
        <div className="mail-alert" role="alert">
          <WarningCircle size={18} />
          <span>{error}</span>
          <button aria-label="关闭错误" onClick={() => setError('')}>
            <X />
          </button>
        </div>
      )}
      {notice && (
        <div className="mail-notice" role="status">
          {notice}
        </div>
      )}
      <div className={'mail-shell ' + (thread || draft ? 'has-detail' : '')}>
        <aside className="mail-folders">
          <span className="mail-section-label">邮件文件夹</span>
          {folders.map(([id, label, Icon]) => (
            <button
              key={id}
              className={folder === id ? 'active' : ''}
              onClick={() => {
                setFolder(id);
                setOffset(0);
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              <small>
                {id === 'drafts'
                  ? data.drafts.filter((d) => ['draft', 'queued', 'sending'].includes(d.status))
                      .length
                  : id === 'failed'
                    ? data.drafts.filter((d) =>
                        ['failed', 'uncertain', 'needs_review'].includes(d.status),
                      ).length
                    : data.counts[id] || 0}
              </small>
            </button>
          ))}
          <div className="mail-sidebar-note">
            <CheckCircle size={18} />
            <p>
              草稿自动保存在平台
              <br />
              发送前，由你确认
            </p>
          </div>
        </aside>
        <section className="mail-list">
          <div className="mail-list-tools">
            <div className="mail-search">
              <MagnifyingGlass size={17} />
              <input
                aria-label="搜索邮件"
                placeholder="搜索邮件、联系人"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setOffset(0);
                }}
              />
            </div>
            <label className="mail-unread">
              <input
                type="checkbox"
                checked={unread}
                onChange={(e) => {
                  setUnread(e.target.checked);
                  setOffset(0);
                }}
              />{' '}
              仅未读
            </label>
          </div>
          <div className="mail-list-title">
            <strong>{folders.find((f) => f[0] === folder)?.[1]}</strong>
            <span>
              {['drafts', 'failed'].includes(folder) ? activeDrafts.length : data.total || 0} 个
              {['drafts', 'failed'].includes(folder) ? '邮件' : '会话'}
            </span>
          </div>
          <div className="mail-list-scroll">
            {['drafts', 'failed'].includes(folder)
              ? activeDrafts.map((d) => (
                  <button
                    className={'mail-row ' + (draft?.id === d.id ? 'selected' : '')}
                    key={d.id}
                    onClick={() => openDraft(d)}
                    disabled={busy}
                  >
                    <div className="mail-row-top">
                      <strong>{d.to}</strong>
                      <time>{date(d.updatedAt)}</time>
                    </div>
                    <b>{d.subject || '（无主题）'}</b>
                    <p>{d.body || '尚未填写正文'}</p>
                    <div className="mail-row-bottom">
                      <span>{d.accountEmail?.split('@')[0]}</span>
                      <em>{labels[d.status]}</em>
                    </div>
                  </button>
                ))
              : data.threads.map((t) => (
                  <button
                    className={
                      'mail-row ' +
                      (thread?.messages.some((m) => m.id === t.id) ? 'selected ' : '') +
                      (t.unread ? 'unread' : '')
                    }
                    key={t.id}
                    onClick={() => open(t)}
                    disabled={busy}
                  >
                    <div className="mail-row-top">
                      <strong>
                        {t.unread && <i />}
                        {t.participants[0] || '未知发件人'}
                      </strong>
                      <time>{date(t.date)}</time>
                    </div>
                    <b>{t.subject}</b>
                    <p>{t.snippet || '查看邮件内容'}</p>
                    <div className="mail-row-bottom">
                      <span>{t.accountEmail?.split('@')[0]}</span>
                      <em>
                        {t.count > 1
                          ? t.count + ' 封往来'
                          : t.campaignNames.length
                            ? '批量任务'
                            : ''}
                      </em>
                    </div>
                  </button>
                ))}
            {loading && <p className="mail-empty-small">正在加载…</p>}
            {!loading &&
              (['drafts', 'failed'].includes(folder)
                ? !activeDrafts.length
                : !data.threads.length) && (
                <div className="mail-list-empty">
                  <Tray size={32} />
                  <p>这里暂时没有邮件</p>
                  <small>试试其他筛选条件或同步邮箱</small>
                </div>
              )}
          </div>
          {!['drafts', 'failed'].includes(folder) && (
            <div className="mail-pagination">
              <button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 40))}>
                上一页
              </button>
              <span>{Math.floor(offset / 40) + 1}</span>
              <button
                disabled={offset + 40 >= (data.total || 0)}
                onClick={() => setOffset(offset + 40)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
        <section className="mail-detail">
          {!thread && !draft ? (
            <div className="mail-welcome">
              <div>
                <EnvelopeOpen size={38} />
              </div>
              <h2>从一封邮件，继续对话</h2>
              <p>
                选择左侧会话查看往来，
                <br />
                自己撰写，或让AI协助起草。
              </p>
              <span>全部账号 · 完整会话 · 人工确认</span>
            </div>
          ) : (
            <>
              <div className="mail-detail-toolbar">
                <button className="mail-back" disabled={busy} onClick={() => closeEditor(true)}>
                  <ArrowLeft size={17} /> 返回
                </button>
                <span>{thread?.accountEmail || draft?.accountEmail}</span>
                {thread && (
                  <button className="mail-link" disabled={busy} onClick={read}>
                    <EnvelopeSimple size={17} />
                    标为未读
                  </button>
                )}
              </div>
              <div className="mail-detail-scroll">
                <div className="mail-subject">
                  <h2>{thread?.subject || draft?.subject || '新邮件'}</h2>
                  {thread && (
                    <p>
                      {thread.messages.length} 封邮件
                      {thread.campaignNames.length ? ' · ' + thread.campaignNames.join(' / ') : ''}
                    </p>
                  )}
                </div>
                {thread?.messages.map((m, i) => (
                  <details
                    className={
                      'mail-message' + (m.id === focusMessageId ? ' mail-message-focused' : '')
                    }
                    id={'mail-message-' + m.id}
                    key={m.id}
                    open={m.id === focusMessageId || i === thread.messages.length - 1}
                  >
                    <summary>
                      <span className={'mail-avatar ' + (m.outgoing ? 'outgoing' : '')}>
                        {(m.from?.[0] || '?')[0].toUpperCase()}
                      </span>
                      <div>
                        <strong>{m.outgoing ? '我' : m.from?.join(', ')}</strong>
                        <span>收件人：{m.to?.join(', ')}</span>
                      </div>
                      <time>{date(m.date)}</time>
                    </summary>
                    <div className="mail-message-body">
                      <p className="mail-full-address">
                        发件人：{m.from?.join(', ')}
                        {m.replyTo?.length ? ' · 回复至：' + m.replyTo.join(', ') : ''}
                      </p>
                      <pre>{m.text || '正文尚未同步，请同步邮件后查看。'}</pre>
                      {m.truncated && (
                        <p className="mail-warning">
                          邮件较长，此处仅展示部分内容，请到原邮箱查看完整邮件。
                        </p>
                      )}
                      {m.attachments?.length > 0 && (
                        <p className="mail-attachments">
                          <Paperclip /> {m.attachments.map((a) => a.name).join('、')}
                          （请在原邮箱下载）
                        </p>
                      )}
                      {m.submissionOnly && <small>SMTP已接受，等待邮箱已发送记录同步</small>}
                    </div>
                  </details>
                ))}
                {!draft && thread && (
                  <button className="button mail-reply-start" disabled={busy} onClick={beginReply}>
                    <ArrowBendUpLeft size={18} /> 回复此会话
                  </button>
                )}
                {draft && (
                  <div className="mail-editor">
                    {draft.threadId &&
                      thread &&
                      draft.contextVersion !== thread.contextVersion &&
                      editable && (
                        <div className="mail-alert">
                          会话有新来信，请阅读上方内容后重新核对。
                          <button
                            onClick={() => {
                              updateDraft({ ...draft, contextVersion: thread.contextVersion });
                              markEdited();
                            }}
                          >
                            已核对最新会话
                          </button>
                        </div>
                      )}
                    <div className="mail-editor-header">
                      <button
                        type="button"
                        className="mail-icon-button"
                        aria-label={draft.threadId ? '关闭回复' : '取消写邮件'}
                        title="返回，已填写内容自动保存为草稿"
                        disabled={busy}
                        onClick={() => closeEditor()}
                      >
                        <ArrowLeft size={18} />
                      </button>
                      <strong>{draft.threadId ? '回复' : '写邮件'}</strong>
                      <span>
                        {dirty
                          ? '有未保存修改'
                          : draft.status === 'new'
                            ? '新草稿'
                            : labels[draft.status]}
                      </span>
                    </div>
                    <div className="mail-envelope">
                      <label>
                        发件人
                        {editable ? (
                          <select
                            aria-label="发件人"
                            value={draft.accountId}
                            onChange={(e) => {
                              const a = data.accounts.find((a) => a.id === e.target.value);
                              updateDraft({ ...draft, accountId: a.id, accountEmail: a.email });
                              markEdited();
                            }}
                          >
                            {data.accounts.map((a) => (
                              <option key={a.id} value={a.id} disabled={a.disabled}>
                                {a.email}
                                {a.replyOnly ? '（只做回复用）' : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span>{draft.accountEmail}</span>
                        )}
                      </label>
                      <label>
                        收件人
                        {editable && !draft.threadId ? (
                          <input
                            aria-label="收件人"
                            value={draft.to}
                            placeholder="name@example.com"
                            onChange={(e) => {
                              updateDraft({ ...draft, to: e.target.value });
                              markEdited();
                            }}
                          />
                        ) : (
                          <span>{draft.to}</span>
                        )}
                      </label>
                      {!draft.threadId && (
                        <label>
                          主题
                          <input
                            aria-label="邮件主题"
                            disabled={!editable}
                            value={draft.subject}
                            onChange={(e) => {
                              updateDraft({ ...draft, subject: e.target.value });
                              markEdited();
                            }}
                          />
                        </label>
                      )}
                    </div>
                    {draft.threadId && draft.accountId !== thread?.accountId && (
                      <div className="mail-alert">
                        将使用 {draft.accountEmail} 回复，后续来信会发送到该邮箱。
                      </div>
                    )}
                    <textarea
                      aria-label="回复正文"
                      placeholder="写下你的回复…"
                      value={body}
                      disabled={!editable || busy}
                      onChange={(e) => onBody(e.target.value)}
                    />
                    {draft.error && (
                      <div className="mail-alert">
                        {draft.error}
                        {['uncertain', 'needs_review'].includes(draft.status)
                          ? '。请核对原邮箱，平台不会自动重发。'
                          : ''}
                      </div>
                    )}
                    {showAI && editable && (
                      <div className="mail-ai-panel">
                        <strong>
                          <Sparkle size={17} /> AI写作助手
                        </strong>
                        <p>
                          自动使用系统话术和当前会话全部已同步正文，交给已配置的模型生成。建议经你确认后才发送。
                        </p>
                        <details>
                          <summary>系统业务话术（可选，所有账号共用）</summary>
                          <textarea
                            aria-label="系统业务话术"
                            placeholder="暂未配置也可生成；后续在这里补充产品信息、话术和回复规则。"
                            value={rules}
                            maxLength={15000}
                            onChange={(e) => setRules(e.target.value)}
                          />
                          <button
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              safely(async () => {
                                await api('/inbox/reply-preset', {
                                  method: 'PUT',
                                  body: { rules },
                                });
                                setNotice('系统业务话术已保存，后续生成自动使用');
                              })
                            }
                          >
                            保存系统话术
                          </button>
                        </details>
                        <button className="button" disabled={busy} onClick={generate}>
                          {busy ? '正在生成…' : '生成建议'}
                        </button>
                        {suggestion && (
                          <div className="mail-suggestion">
                            <pre>{suggestion}</pre>
                            <button
                              className="button"
                              onClick={() => {
                                onBody(suggestion);
                                setSuggestion('');
                                setShowAI(false);
                              }}
                            >
                              采用建议（替换当前正文）
                            </button>
                            <button className="mail-link" onClick={() => setSuggestion('')}>
                              不采用
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="mail-editor-actions">
                      <div>
                        <button
                          className="button primary"
                          disabled={!editable || busy || !body.trim()}
                          onClick={send}
                        >
                          <PaperPlaneTilt size={17} />
                          确认发送
                        </button>
                        <button
                          className="mail-icon-button"
                          title="保存草稿"
                          aria-label="保存草稿"
                          disabled={!editable || busy}
                          onClick={() =>
                            safely(async () => {
                              await persistNew();
                              setNotice('草稿已保存');
                              await refresh();
                            })
                          }
                        >
                          <FloppyDisk size={19} />
                        </button>
                        {draft.id && editable && (
                          <button
                            className="mail-icon-button"
                            title="删除草稿"
                            aria-label="删除草稿"
                            disabled={busy}
                            onClick={() =>
                              safely(async () => {
                                if (!window.confirm('确定删除这份未发送的草稿？')) return;
                                await api('/inbox/drafts/' + draft.id, { method: 'DELETE' });
                                editing.current = false;
                                setDirty(false);
                                updateDraft(null);
                                await refresh();
                              })
                            }
                          >
                            <Trash size={19} />
                          </button>
                        )}
                      </div>
                      <button
                        className="mail-ai-button"
                        disabled={!editable || busy}
                        onClick={() =>
                          safely(async () => {
                            if (!showAI) setRules((await api('/inbox/reply-preset')).rules);
                            setShowAI(!showAI);
                          })
                        }
                      >
                        <Sparkle size={17} /> AI生成文案
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
      <footer className="mail-footer">
        <span>
          <Clock size={13} />{' '}
          {data.sync.length
            ? '后台增量同步 · 仅 2026/09/10 起（北京时间）'
            : '仅展示 2026/09/10 起的邮件 · 点击同步更新'}
        </span>
        <span>邮箱草稿为只读 · 平台草稿独立保存</span>
      </footer>
      {data.sync.filter((s) => s.error).length > 0 && (
        <details className="mail-sync-errors">
          <summary>部分账号同步异常（{data.sync.filter((s) => s.error).length}）</summary>
          {data.sync
            .filter((s) => s.error)
            .map((s) => (
              <p key={s.id}>
                {data.accounts.find((a) => a.id === s.id)?.email}：{s.error}
              </p>
            ))}
        </details>
      )}
    </div>
  );
}
