import ImportTasks from './ImportTasks.jsx';
import { clientId } from './client-id.js';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  IconContext,
  PaperPlaneTilt,
  SquaresFour,
  Users,
  EnvelopeSimple,
  Stack,
  GearSix,
  Plus,
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Check,
  CheckCircle,
  X,
  UploadSimple,
  FileXls,
  DownloadSimple,
  MagnifyingGlass,
  Clock,
  Pause,
  Play,
  WarningCircle,
  Trash,
  Flask,
  Eye,
  FloppyDisk,
  CaretDown,
  CaretRight,
  Lightning,
  ShieldCheck,
  FileText,
  Copy,
  SpinnerGap,
  Tray,
  CalendarBlank,
  Question,
  StopCircle,
} from '@phosphor-icons/react';
import './styles.css';
import Followup from './Followup.jsx';
import BatchReports from './BatchReports.jsx';
import Inbox from './Inbox.jsx';
import Unscheduled from './Unscheduled.jsx';
import PaginatedResults from './PaginatedResults.jsx';
import CampaignBuilder from './CampaignBuilder.jsx';
import AccountPasswordHelp from './AccountPasswordHelp.jsx';
let token = '';
async function api(url, options = {}) {
  const headers = { 'x-postlane-token': token, ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch('/api' + url, { ...options, headers });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      response.status === 504 ? '服务响应超时，请稍后重试' : '服务暂时不可用，请稍后重试',
    );
  }
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
const statusText = {
  draft: '草稿',
  scheduled: '已预约',
  running: '发送中',
  paused: '未排期',
  attention: '需要处理',
  retry_wait: '等待自动重试',
  needs_review: '需要人工确认',
  completed: '已完成',
  completed_errors: '部分异常',
  cancelled: '已取消',
  pending: '待发送',
  sending: '提交中',
  sent: '发送服务已接受',
  simulated: '演练完成',
  failed: '发送失败',
  uncertain: '待核对',
};
const presets = [
  {
    id: 'welcome',
    name: '一封温暖的欢迎信',
    tag: '客户关系',
    color: 'mint',
    subject: '{{姓名}}，很高兴与你相遇',
    body: '{{姓名}}，你好！\n\n很高兴与你建立联系。感谢你对我们的关注，也期待未来有机会与{{公司}}一起探索更多可能。\n\n如果你有任何问题或想法，直接回复这封邮件就好。我们很乐意听听你的声音。\n\n祝好，\n你的合作伙伴',
  },
  {
    id: 'invite',
    name: '让好想法，面对面发生',
    tag: '活动邀请',
    color: 'sand',
    subject: '{{姓名}}，想邀请你参加我们的交流活动',
    body: '{{姓名}}，你好！\n\n我们正在筹备一场小型交流活动，希望邀请来自{{公司}}的你一起参加。\n\n这将是一次分享实践、碰撞想法的机会。如果你感兴趣，欢迎回复邮件，我们会与你确认活动时间和参与方式。\n\n期待与你见面！',
  },
  {
    id: 'follow',
    name: '一次恰到好处的跟进',
    tag: '业务跟进',
    color: 'blue',
    subject: '{{姓名}}，关于我们上次的交流',
    body: '{{姓名}}，你好！\n\n感谢你之前抽时间与我们交流。关于{{公司}}的需求，我们想继续了解你的想法。\n\n如果还有需要补充的资料或讨论的问题，请随时告诉我们。我们也可以约一个方便的时间继续聊聊。\n\n期待你的回复，祝工作顺利。',
  },
];
const date = (v) =>
  v
    ? new Date(v).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '尚未发送';
const num = (n) => Number(n || 0).toLocaleString('zh-CN');
const render = (s, fields) =>
  s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, k) =>
    Object.hasOwn(fields, k) ? (fields[k] ?? `{{${k}}}`) : `{{${k}}}`,
  );
const blank = () => ({
  name: '未命名邮件任务',
  subject: '',
  body: '',
  listId: '',
  mode: 'live',
  rate: 20,
  randomInterval: true,
  scheduledAt: null,
});
function Badge({ status, children }) {
  return (
    <span className={'badge ' + status}>
      <i />
      {children || statusText[status] || status}
    </span>
  );
}
function Button({ children, kind = '', className = '', ...props }) {
  return (
    <button className={`button ${kind} ${className}`} {...props}>
      {children}
    </button>
  );
}
function Empty({ icon: Icon = Tray, title, desc, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={28} />
      </span>
      <h3>{title}</h3>
      <p>{desc}</p>
      {action}
    </div>
  );
}
function Modal({ title, subtitle, onClose, children, wide = false, className = '' }) {
  const ref = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const els = [
          ...ref.current.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]'),
        ].filter((n) => !n.disabled);
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        className={'modal ' + (wide ? 'wide ' : '') + className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={21} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function App() {
  const [state, setState] = useState(null),
    [page, setPage] = useState(
      new URLSearchParams(location.search).get('importTaskId') ? 'campaigns' : 'overview',
    ),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(false);
  const [importOpen, setImportOpen] = useState(false),
    [compose, setCompose] = useState(null),
    [step, setStep] = useState(0),
    [selectedList, setSelectedList] = useState(null),
    [detail, setDetail] = useState(null),
    [listDetail, setListDetail] = useState(null),
    [confirm, setConfirm] = useState(false),
    [liveCheck, setLiveCheck] = useState(false),
    [testOpen, setTestOpen] = useState(false),
    [testAddress, setTestAddress] = useState(''),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [unscheduledCount, setUnscheduledCount] = useState(null),
    [previewIndex, setPreviewIndex] = useState(0),
    [followupCampaign, setFollowupCampaign] = useState(''),
    [followupView, setFollowupView] = useState(null),
    [inboxTarget, setInboxTarget] = useState(null);
  const [taskView, setTaskView] = useState('imports');
  const [showUnscheduled, setShowUnscheduled] = useState(false);
  const [importTaskId, setImportTaskId] = useState(
    new URLSearchParams(location.search).get('importTaskId') || '',
  );
  const [taskDirectory, setTaskDirectory] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      api('/import-tasks')
        .then((d) => {
          if (active) setTaskDirectory(d);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  function selectImportTask(id) {
    setImportTaskId(id);
    const url = new URL(location.href);
    if (id) url.searchParams.set('importTaskId', id);
    else url.searchParams.delete('importTaskId');
    history.replaceState(null, '', url);
  }
  function taskFollowup(id) {
    selectImportTask(id);
    setFollowupView(null);
    go('followup');
  }
  const [runtimeStatus, setRuntimeStatus] = useState(null);
  useEffect(() => {
    if (state?.runtimeMode !== 'live') return;
    let stopped = false,
      timer;
    const poll = async () => {
      try {
        const next = await api('/runtime');
        if (!stopped) setRuntimeStatus(next);
      } catch {
        if (!stopped) setRuntimeStatus((old) => ({ ...old, unavailable: true }));
      } finally {
        if (!stopped) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [state?.runtimeMode]);
  const workerState = runtimeStatus?.workerState || state?.workerState;
  const submissionsEnabled = runtimeStatus?.submissionsEnabled ?? state?.submissionsEnabled;
  const previousIncoming = useRef(null);
  const halted = Boolean(state?.halt?.halted);
  // One switch for "stop everything now": campaigns, replies and report deliveries all read
  // the same flag, so nothing keeps trickling out while the operator is panicking.
  const toggleHalt = () =>
    run(async () => {
      const next = !halted;
      if (next && !window.confirm('立即停止全部发送？正在发送的这一封会完成，其余全部挂起。'))
        return;
      await api('/send-halt', {
        method: 'POST',
        body: { halted: next, reason: next ? '操作台急停' : '操作台恢复' },
      });
      await refresh();
      setToast(next ? '已停止所有发送：进行中的任务会停在下一封之前' : '已恢复发送');
    });
  const refresh = async () => {
    const s = await api('/state');
    token = s.token;
    if (
      previousIncoming.current !== null &&
      s.followup?.latestIncomingAt > previousIncoming.current
    )
      setToast('有新的回复或投递异常，前往「回复与跟进」查看');
    previousIncoming.current = s.followup?.latestIncomingAt || '';
    setState(s);
    setOffline(false);
    return s;
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => refresh().catch(() => setOffline(true)), 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!compose?.listId) {
      setSelectedList(null);
      return;
    }
    setSelectedList(null);
    let active = true;
    api('/lists/' + compose.listId)
      .then((l) => {
        if (active) {
          setSelectedList(l);
          setPreviewIndex(0);
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [compose?.listId]);
  useEffect(() => {
    if (!detail) return;
    const t = setInterval(
      () =>
        api('/campaigns/' + detail.id)
          .then(setDetail)
          .catch((e) => setError(e.message)),
      1800,
    );
    return () => clearInterval(t);
  }, [detail?.id]);
  useEffect(() => {
    if (!compose) return;
    const f = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [!!compose]);
  async function run(fn) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function go(p, { fromFollowup = false } = {}) {
    if (
      page === 'inbox' &&
      p !== 'inbox' &&
      !window.dispatchEvent(new Event('postlane-leave-inbox', { cancelable: true }))
    )
      return;
    if (p === 'followup') setFollowupCampaign('');
    if (p === 'inbox' && !fromFollowup) setInboxTarget(null);
    setPage(p);
    setQuery('');
    setFilter('all');
  }
  function start(preset) {
    setCompose({
      ...blank(),
      multi: !preset,
      builderKey: clientId(),
      accountId: state.accounts?.find((a) => !a.disabled && !a.replyOnly)?.id || '',
      ...(preset ? { name: preset.name, subject: preset.subject, body: preset.body } : {}),
    });
    setStep(0);
    setPage('compose');
  }
  function update(values) {
    setCompose((c) => ({ ...c, ...values }));
  }
  async function save() {
    if (compose.mode === 'live' && !compose.accountId) throw new Error('请选择发件账号');
    const c = await api('/campaigns' + (compose.id ? '/' + compose.id : ''), {
      method: compose.id ? 'PUT' : 'POST',
      body: compose,
    });
    setCompose(c);
    await refresh();
    return c;
  }
  async function openCampaign(c) {
    await run(async () => {
      const full = await api('/campaigns/' + c.id);
      if (c.status === 'draft') {
        setCompose(full);
        setStep(0);
        setPage('compose');
      } else setDetail(full);
    });
  }
  async function action(c, a) {
    await run(async () => {
      const value = await api(
        '/campaigns/' + c.id + (a === 'marketing-sync' ? '/marketing-sync' : '/action'),
        {
          method: 'POST',
          body: {
            action: a,
            confirmLive: true,
            marketingFooterAccepted: c.provider === 'mailchimp-marketing',
          },
        },
      );
      setDetail(value);
      await refresh();
      setToast('任务状态已更新');
    });
  }
  const isMarketing =
    state?.accounts?.find((a) => a.id === compose?.accountId)?.provider === 'mailchimp-marketing';
  const marketingCount =
    isMarketing && selectedList
      ? new Set(
          selectedList.contacts.map((r) =>
            JSON.stringify([render(compose.subject, r.fields), render(compose.body, r.fields)]),
          ),
        ).size
      : 0;
  const recipient = selectedList?.contacts[previewIndex];
  const fields = recipient?.fields || { 姓名: '林小满', 公司: '山野设计', 称呼: '小满' };
  const previewSubject = render(compose?.subject || '邮件主题将在这里显示', fields),
    previewBody = render(
      compose?.body || '写下你的第一句话。\n\n这里会实时呈现收件人看到的邮件。',
      fields,
    );
  const stats = state
    ? state.campaigns.reduce(
        (s, c) => ({
          sent: s.sent + (c.counts.sent || 0),
          simulated: s.simulated + (c.counts.simulated || 0),
          failed: s.failed + (c.counts.failed || 0),
          active:
            s.active + (['running', 'scheduled', 'paused', 'attention'].includes(c.status) ? 1 : 0),
        }),
        { sent: 0, simulated: 0, failed: 0, active: 0 },
      )
    : {};
  const nav = [
    ['overview', SquaresFour, '工作概览'],
    ['inbox', EnvelopeSimple, '邮箱'],
    ['campaigns', PaperPlaneTilt, '发送任务'],
    ['followup', Tray, '回复与跟进'],
    ['contacts', Users, '批量任务'],
  ];
  const tasks =
    state?.campaigns.filter(
      (c) =>
        (!importTaskId || taskDirectory?.campaignSlices?.[c.id]?.[importTaskId]) &&
        (filter === 'all' || c.status === filter) &&
        c.name.toLowerCase().includes(query.toLowerCase()),
    ) || [];
  function taskTable(items) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>邮件任务</th>
              <th>收件人</th>
              <th>状态</th>
              <th>完成进度</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => {
              const slice = importTaskId && taskDirectory?.campaignSlices?.[c.id]?.[importTaskId];
              const cc = slice?.counts || c.counts,
                total = slice?.total ?? c.total;
              const done = (cc.sent || 0) + (cc.simulated || 0) + (cc.failed || 0);
              return (
                <tr key={c.id} onClick={() => openCampaign(c)}>
                  <td>
                    <div className="task-title">
                      <span className={'table-icon ' + (c.mode === 'simulation' ? 'neutral' : '')}>
                        <EnvelopeSimple size={20} />
                      </span>
                      <div>
                        <button
                          className="text-button task-name"
                          onClick={(e) => {
                            e.stopPropagation();
                            openCampaign(c);
                          }}
                        >
                          {c.name}
                        </button>
                        <small>
                          {c.mode === 'simulation' ? '演练任务' : c.subject || '还未填写主题'}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    {num(total)}
                    <small>{slice ? `本任务 / 子任务共 ${c.total} 封` : '位收件人'}</small>
                  </td>
                  <td>
                    <Badge status={c.status} />
                  </td>
                  <td>
                    <div className="mini-progress">
                      <i style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
                    </div>
                    <small>
                      {done} / {total}
                    </small>
                  </td>
                  <td className="muted">{date(c.createdAt)}</td>
                  <td>
                    <CaretRight size={16} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
  if (!state)
    return (
      <div className="loading-page">
        <PaperPlaneTilt size={38} />
        <h2>Postlane 邮序</h2>
        {error ? (
          <>
            <p>{error}</p>
            <Button onClick={() => run(refresh)}>重新连接</Button>
          </>
        ) : (
          <p>正在准备你的工作台…</p>
        )}
      </div>
    );
  return (
    <IconContext.Provider value={{ size: 20, weight: 'regular' }}>
      <div className="app-shell">
        <aside className="sidebar">
          <a
            className="brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              go('overview');
            }}
          >
            <span className="brand-mark">
              <PaperPlaneTilt size={25} weight="fill" />
            </span>
            <span>postlane</span>
          </a>
          <div className="workspace">
            <span className="workspace-avatar">P</span>
            <div>
              我的邮件工作台<small>邮件协作空间</small>
            </div>
            <span className="local-dot" />
          </div>
          <div className="nav-label">工作空间</div>
          <nav>
            {nav.map(([id, Icon, label]) => (
              <button
                key={id}
                className={'nav-item ' + (page === id ? 'active' : '')}
                onClick={() => go(id)}
              >
                <Icon weight={page === id ? 'fill' : 'regular'} />
                {label}
                {id === 'followup' && state.followup?.pending > 0 && (
                  <span className="nav-count">{state.followup.pending}</span>
                )}
                {id === 'campaigns' && state.campaigns.length > 0 && (
                  <span className="nav-count">
                    {taskDirectory?.items.filter((t) => t.origin !== 'unknown').length ?? '—'}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <span className="note-symbol">
                <ShieldCheck size={22} />
              </span>
              <strong>每一次发送，都有记录</strong>
              <p>
                你的邮件任务和发送进度
                <br />
                统一保存在平台中。
              </p>
              <span>
                WORKSPACE <i />
              </span>
            </div>
            <button
              className={'nav-item ' + (page === 'settings' ? 'active' : '')}
              onClick={() => go('settings')}
            >
              <GearSix />
              发件设置{!state.settings && <i className="amber-dot" />}
            </button>
            <div className="profile">
              <div className="profile-avatar">我</div>
              <div>
                我的工作空间<small>Postlane · v1.2</small>
              </div>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumbs">
              工作空间
              <CaretRight size={13} />
              <span>
                {page === 'compose'
                  ? '新建邮件任务'
                  : nav.find((n) => n[0] === page)?.[2] ||
                    { reports: '批次详情', templates: '邮件模板' }[page] ||
                    '发件设置'}
              </span>
            </div>
            <div className="topbar-right">
              {state.runtimeMode === 'live' &&
                workerState &&
                (workerState !== 'owned' || runtimeStatus?.unavailable) && (
                  <span className="connection warning" role="status">
                    {runtimeStatus?.unavailable
                      ? '后台状态暂时无法确认，正在重新连接'
                      : submissionsEnabled
                        ? runtimeStatus?.workerWaitMs > 180000
                          ? '后台恢复超过预期，请联系维护人员；批量任务仍可保存'
                          : '后台发送与同步恢复中；可提交批量任务，恢复后按计划执行'
                        : '服务更新中，正在恢复任务，请稍候'}
                  </span>
                )}
              {state.runtimeMode === 'verify' && (
                <span className="connection warning" role="status">
                  核验模式 · 只读，发送与同步已禁用
                </span>
              )}
              {state.runtimeMode === 'live' && (
                <button
                  type="button"
                  className={'halt-switch' + (halted ? ' halted' : '')}
                  onClick={toggleHalt}
                  disabled={busy}
                  title={
                    halted
                      ? '所有发送已暂停，点击恢复'
                      : '立刻停止全部发送（活动任务、回复、报告投递）'
                  }
                >
                  <StopCircle size={16} weight={halted ? 'fill' : 'regular'} />
                  {halted ? '已停发 · 恢复' : '全部停发'}
                </button>
              )}
              <span className={'connection ' + (offline ? 'warning' : '')}>
                <i />
                {offline ? '连接已中断' : state.settings ? '发件账号已配置' : '发件账号待配置'}
              </span>
              {state.awake?.active && <span className="connection">任务防休眠已启用</span>}
              {state.awake?.error && <span className="connection warning">防休眠启用失败</span>}
              <span className="top-avatar">P</span>
            </div>
          </header>
          {halted && (
            <div className="halt-banner" role="alert">
              <StopCircle size={18} weight="fill" />
              <span>
                已全站停发（{state.halt?.reason || '手动急停'}
                {state.halt?.halted && state.halt?.at
                  ? ' · ' + new Date(state.halt.at).toLocaleString('zh-CN')
                  : ''}
                ）。已排队的任务不会丢，恢复后从当前收件人继续。
              </span>
              <button type="button" onClick={toggleHalt} disabled={busy}>
                恢复发送
              </button>
            </div>
          )}
          <main key={page} className={page === 'inbox' ? 'inbox-main' : ''}>
            {page === 'inbox' && (
              <Inbox
                api={api}
                initialTarget={inboxTarget}
                onBackToFollowup={() => go('followup')}
              />
            )}
            {page === 'reports' && (
              <BatchReports
                importTasks={taskDirectory?.items || []}
                importTaskId={importTaskId}
                onImportTaskChange={selectImportTask}
                backup={state.backup}
                reportRecipients={state.reportRecipients}
                api={api}
                campaigns={state.campaigns}
              />
            )}
            {page === 'followup' && (
              <Followup
                importTasks={taskDirectory?.items || []}
                importTaskId={importTaskId}
                onImportTaskChange={selectImportTask}
                initialView={followupView}
                onViewChange={setFollowupView}
                onOpenThread={(eventId) => {
                  setInboxTarget({ eventId, key: clientId() });
                  go('inbox', { fromFollowup: true });
                }}
                initialCampaign={followupCampaign}
                api={api}
                campaigns={state.campaigns}
                onOpen={openCampaign}
                refresh={refresh}
              />
            )}
            {page === 'overview' && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">YOUR MAIL, IN ORDER</div>
                    <h1>
                      每一次沟通，都井然有序<span className="heading-dot">.</span>
                    </h1>
                    <p>从导入批量任务到点击发送，在这里完成下一次连接。</p>
                  </div>
                  <Button kind="primary" onClick={() => start()}>
                    <Plus />
                    新建邮件任务
                  </Button>
                </div>
                <section className="welcome-banner">
                  <div>
                    <span className="banner-label">
                      <span />
                      一张表格，一次新的连接
                    </span>
                    <h2>
                      准备好你的批量任务，
                      <br />
                      把心意送到每个人面前。
                    </h2>
                    <p>导入 Excel · 个性化邮件 · 有节奏地发送</p>
                    <Button kind="white" onClick={() => setImportOpen(true)}>
                      <UploadSimple size={18} />
                      导入批量任务
                      <ArrowUpRight size={17} />
                    </Button>
                  </div>
                  <div className="mail-art" aria-hidden="true">
                    <div className="orbit orbit-one" />
                    <div className="orbit orbit-two" />
                    <span className="art-spark spark-one">+</span>
                    <span className="art-spark spark-two">+</span>
                    <div className="art-label art-label-top">
                      <FileXls size={18} />
                      <span>contacts.xlsx</span>
                      <CheckCircle size={16} weight="fill" />
                    </div>
                    <div className="envelope-back" />
                    <div className="letter-paper">
                      <span className="letter-logo">
                        <PaperPlaneTilt weight="fill" size={19} /> postlane
                      </span>
                      <div className="letter-greeting">
                        Hi, <span>小满</span>
                      </div>
                      <i />
                      <i />
                      <i className="short" />
                      <div className="letter-sign">很高兴，与你相遇。</div>
                    </div>
                    <div className="envelope-front" />
                    <div className="envelope-seal">
                      <PaperPlaneTilt size={28} weight="fill" />
                    </div>
                    <div className="art-label art-label-bottom">
                      <span className="label-check">
                        <Check size={13} />
                      </span>
                      每一封，都为你而写
                    </div>
                  </div>
                </section>
                <ImportTasks
                  accounts={state.accounts}
                  api={api}
                  compact
                  onReports={(id) => {
                    selectImportTask(id);
                    go('reports');
                  }}
                  onFollowup={taskFollowup}
                  onFilter={selectImportTask}
                  onCampaign={(id) => openCampaign(state.campaigns.find((c) => c.id === id))}
                />

                <footer>
                  POSTLANE 邮序<span>把繁琐留给工具，把温度留给沟通。</span>
                </footer>
              </>
            )}
            {page === 'campaigns' && (
              <>
                <PageTitle
                  eyebrow="CAMPAIGNS"
                  title="发送任务"
                  desc="草稿、预约、发送进度，集中管理。"
                  action={
                    <Button kind="primary" onClick={() => start()}>
                      <Plus />
                      新建任务
                    </Button>
                  }
                />
                <div className="import-view-toggle">
                  <Button
                    kind={taskView === 'imports' ? 'primary' : ''}
                    onClick={() => setTaskView('imports')}
                  >
                    导入任务
                  </Button>
                  <Button
                    kind={taskView === 'children' ? 'primary' : ''}
                    onClick={() => setTaskView('children')}
                  >
                    执行子任务
                  </Button>
                </div>
                {taskView === 'imports' ? (
                  <>
                    <section className="panel">
                      <div className="toolbar">
                        <Button onClick={() => setShowUnscheduled((v) => !v)}>
                          {showUnscheduled ? '收起未排期邮件' : '查看未排期邮件'}
                          {unscheduledCount === null ? '' : ` · ${unscheduledCount} 封`}
                        </Button>
                        <Button kind="primary" onClick={() => start()}>
                          安排发送
                        </Button>
                      </div>
                      <Unscheduled
                        state={state}
                        api={api}
                        active={showUnscheduled}
                        query=""
                        onCount={setUnscheduledCount}
                        onOpen={setListDetail}
                      />
                    </section>
                    <ImportTasks
                      accounts={state.accounts}
                      api={api}
                      selectedId={importTaskId}
                      onFilter={selectImportTask}
                      onReports={(id) => {
                        selectImportTask(id);
                        go('reports');
                      }}
                      onFollowup={taskFollowup}
                      onCampaign={(id) => openCampaign(state.campaigns.find((c) => c.id === id))}
                    />
                  </>
                ) : (
                  <section className="panel">
                    <div className="toolbar">
                      <select
                        aria-label="筛选导入任务"
                        value={importTaskId}
                        onChange={(e) => selectImportTask(e.target.value)}
                      >
                        <option value="">全部导入任务</option>
                        {taskDirectory?.items.map((t) => (
                          <option value={t.id} key={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <div className="filter-tabs">
                        {[
                          ['all', '全部'],
                          ...(state.campaigns.some((c) => c.status === 'draft')
                            ? [['draft', '草稿']]
                            : []),
                          ['unscheduled', '未排期'],
                          ['running', '发送中'],
                          ['scheduled', '已预约'],
                          ['completed', '已完成'],
                        ].map(([id, label]) => (
                          <button
                            className={filter === id ? 'selected' : ''}
                            onClick={() => setFilter(id)}
                            key={id}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <Search value={query} onChange={setQuery} placeholder="搜索任务名称" />
                    </div>
                    <Unscheduled
                      state={state}
                      api={api}
                      active={filter === 'unscheduled'}
                      query={query}
                      onCount={setUnscheduledCount}
                      onOpen={setListDetail}
                    />
                    {filter === 'unscheduled' ? (
                      <div className="toolbar">
                        <Button kind="primary" onClick={() => start()}>
                          安排发送
                        </Button>
                      </div>
                    ) : tasks.length ? (
                      <PaginatedResults key={`${filter}:${query}`} items={tasks}>
                        {taskTable}
                      </PaginatedResults>
                    ) : (
                      <Empty
                        title={query || filter !== 'all' ? '没有匹配的任务' : '还没有发送任务'}
                        desc="从包含邮箱、标题和正文的表格开始。"
                        action={
                          <Button onClick={() => start()}>
                            <Plus />
                            创建任务
                          </Button>
                        }
                      />
                    )}
                  </section>
                )}
              </>
            )}
            {page === 'contacts' && (
              <>
                <PageTitle
                  eyebrow="BATCH TASKS"
                  title="批量任务"
                  desc="导入每封邮件的收件邮箱、标题和正文，集中管理批量任务。"
                  action={
                    <Button kind="primary" onClick={() => setImportOpen(true)}>
                      <UploadSimple />
                      导入批量任务
                    </Button>
                  }
                />
                <div className="info-strip">
                  <FileXls />
                  <span>
                    支持 Excel (.xlsx) 和 UTF-8
                    CSV，示例包含邮箱、标题、正文；自动去重并检查邮箱格式。
                  </span>
                  <a href="/api/sample" download>
                    下载示例表格
                    <DownloadSimple size={16} />
                  </a>
                </div>
                <div className="section-heading">
                  <h2>
                    全部批量任务 <span className="count-label">{state.lists.length}</span>
                  </h2>
                  <Search value={query} onChange={setQuery} placeholder="搜索批量任务" />
                </div>
                <div className="lists-grid">
                  {state.lists
                    .filter((l) => l.name.includes(query))
                    .map((l) => (
                      <div className="list-card" key={l.id}>
                        <div className="list-card-top">
                          <span className="list-icon">
                            <Users size={24} />
                          </span>
                          <button
                            className="icon-button"
                            aria-label={'删除' + l.name}
                            onClick={() =>
                              run(async () => {
                                setListDetail({ ...(await api('/lists/' + l.id)), deleting: true });
                              })
                            }
                          >
                            <Trash size={18} />
                          </button>
                        </div>
                        <h3>{l.name}</h3>
                        <p>{date(l.createdAt)} 导入</p>
                        <div className="list-numbers">
                          <strong>
                            {num(l.count)}
                            <small>可用邮件</small>
                          </strong>
                          <span>{l.issueCount ? `${l.issueCount} 行已排除` : '邮箱校验通过'}</span>
                        </div>
                        <Button
                          onClick={() =>
                            run(async () => setListDetail(await api('/lists/' + l.id)))
                          }
                        >
                          查看邮件明细
                          <ArrowRight size={16} />
                        </Button>
                      </div>
                    ))}
                </div>
                {!state.lists.length && (
                  <section className="panel">
                    <Empty
                      icon={Users}
                      title="导入第一份批量任务"
                      desc="第一行为邮箱、标题、正文，每行对应一封邮件。可按需添加其他字段。"
                      action={
                        <Button kind="primary" onClick={() => setImportOpen(true)}>
                          <UploadSimple />
                          导入第一份批量任务
                        </Button>
                      }
                    />
                  </section>
                )}
              </>
            )}
            {page === 'templates' && (
              <>
                <PageTitle
                  eyebrow="TEMPLATES"
                  title="邮件模板"
                  desc="少一点重复输入，多一点恰到好处的表达。"
                  action={
                    <Button
                      kind="primary"
                      onClick={() => {
                        start();
                        setStep(1);
                      }}
                    >
                      <Plus />
                      从空白开始
                    </Button>
                  }
                />
                <h2 className="subheading">为你的下一次沟通准备</h2>
                <div className="template-grid big">
                  {presets.map((p) => (
                    <TemplateCard key={p.id} preset={p} onUse={() => start(p)} />
                  ))}
                </div>
                <h2 className="subheading">
                  我的模板 <span className="count-label">{state.templates.length}</span>
                </h2>
                {state.templates.length ? (
                  <div className="template-grid">
                    {state.templates.map((p) => (
                      <div className="saved-template" key={p.id}>
                        <div className="saved-template-head">
                          <FileText />
                          <button
                            className="icon-button"
                            aria-label={'删除模板' + p.name}
                            onClick={() =>
                              run(async () => {
                                await api('/templates/' + p.id, { method: 'DELETE' });
                                await refresh();
                                setToast('模板已删除');
                              })
                            }
                          >
                            <Trash size={16} />
                          </button>
                        </div>
                        <h3>{p.name}</h3>
                        <p>{p.subject}</p>
                        <Button onClick={() => start(p)}>
                          使用模板
                          <ArrowRight size={16} />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <section className="panel">
                    <Empty
                      icon={Stack}
                      title="把好用的邮件，留作下一次灵感"
                      desc="编写邮件时点击「存为模板」，即可在这里重复使用。"
                    />
                  </section>
                )}
              </>
            )}
            {page === 'settings' && (
              <Settings
                initial={state.accounts?.[0] || state.settings}
                accounts={state.accounts || []}
                busy={busy}
                run={run}
                refresh={refresh}
                notify={setToast}
              />
            )}
            {page === 'compose' && compose?.multi && (
              <CampaignBuilder
                key={compose.builderKey}
                api={api}
                onLegacy={() => update({ multi: false })}
                onCreated={async (result) => {
                  // The successful submission is durable even if the subsequent
                  // overview refresh fails during deployment.
                  setCompose(null);
                  go('campaigns');
                  setToast(
                    `已创建 ${result.campaignIds.length} 个任务：${result.formal} 封正式邮件、${result.copies} 封副本${result.status === 'draft' ? '，已保存草稿' : result.status === 'scheduled' ? '，已加入预约' : result.waitingForWorker ? '，已保存，等待后台恢复后执行' : '，已加入发送队列'}`,
                  );
                  void refresh().catch(() => setOffline(true));
                }}
              />
            )}
            {page === 'compose' && compose && !compose.multi && (
              <>
                <PageTitle
                  eyebrow="NEW CAMPAIGN"
                  title="让下一次沟通，从这里开始"
                  desc="三步完成准备，让每封邮件都有自己的温度。"
                  action={
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await save();
                          setToast('草稿已保存');
                        })
                      }
                    >
                      <FloppyDisk />
                      保存草稿
                    </Button>
                  }
                />
                <div className="compose-layout">
                  <section className="panel compose-panel">
                    <div className="stepper">
                      {['选择收件人', '编写邮件', '发送设置'].map((label, i) => (
                        <button
                          key={label}
                          className={step === i ? 'current' : step > i ? 'done' : ''}
                          onClick={() => setStep(i)}
                        >
                          <span>{step > i ? <Check size={14} /> : i + 1}</span>
                          {label}
                          {i < 2 && <i />}
                        </button>
                      ))}
                    </div>
                    <div className="compose-content">
                      {step === 0 && (
                        <>
                          <div className="form-section-title">
                            <span>01</span>
                            <div>
                              <h2>这封邮件，写给谁？</h2>
                              <p>选择已有批量任务，或导入包含邮箱、标题、正文的 Excel。</p>
                            </div>
                          </div>
                          <label className="field">
                            发件账号
                            <select
                              value={compose.accountId || ''}
                              onChange={(e) =>
                                update({ accountId: e.target.value, senderEmail: undefined })
                              }
                            >
                              <option value="">请选择发件账号</option>
                              {(state.accounts || [])
                                .filter((a) => !a.disabled && !a.replyOnly)
                                .map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.disabled ? '【不可用】' : ''}
                                    {a.name} · {a.from} ·{' '}
                                    {a.provider === 'mailchimp-marketing'
                                      ? 'Mailchimp Marketing'
                                      : a.provider === 'mailchimp'
                                        ? 'Transactional'
                                        : 'SMTP'}
                                  </option>
                                ))}
                            </select>
                          </label>
                          {isMarketing && (
                            <div className="tip">
                              <EnvelopeSimple />
                              <p>
                                使用账号已选的 Mailchimp
                                Audience。相同标题和正文合并为一个活动，不同内容分别创建活动。目前预计{' '}
                                {marketingCount} 个活动；仅发送给本次 Excel 中符合订阅状态的联系人。
                              </p>
                            </div>
                          )}
                          {isMarketing && (
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={compose.marketingImportConsent === true}
                                onChange={(e) =>
                                  update({ marketingImportConsent: e.target.checked })
                                }
                              />
                              同步新联系人：我确认已获得其营销邮件许可，允许将本次名单中尚不存在的联系人加入
                              Audience。已有退订状态不会被改为订阅。
                            </label>
                          )}
                          <label className="field">
                            任务名称
                            <input
                              value={compose.name}
                              maxLength={100}
                              onChange={(e) => update({ name: e.target.value })}
                              placeholder="例如：九月客户问候"
                            />
                          </label>
                          <label className="field">
                            批量任务
                            <select
                              value={compose.listId}
                              onChange={(e) => update({ listId: e.target.value })}
                            >
                              <option value="">选择一份批量任务</option>
                              {state.lists.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.name} · {l.count} 人
                                </option>
                              ))}
                            </select>
                          </label>
                          <button className="import-inline" onClick={() => setImportOpen(true)}>
                            <span>
                              <UploadSimple size={24} />
                            </span>
                            <strong>导入新的批量任务</strong>
                            <small>拖拽或选择 .xlsx / .csv，单个文件不超过 5 MB</small>
                            <span className="import-inline-link">
                              选择文件
                              <Plus size={16} />
                            </span>
                          </button>
                          {selectedList && (
                            <div className="list-selection">
                              <CheckCircle size={20} weight="fill" />
                              <div>
                                <strong>
                                  {num(selectedList.contacts.length)} 位收件人已准备好
                                </strong>
                                <p>已排除 {selectedList.issues.length} 行重复或无效邮箱。</p>
                              </div>
                            </div>
                          )}
                          <div className="tip">
                            <ShieldCheck size={19} />
                            <p>每位收件人会收到一封独立邮件，互相看不到邮箱地址。</p>
                          </div>
                        </>
                      )}
                      {step === 1 && (
                        <>
                          <div className="form-section-title">
                            <span>02</span>
                            <div>
                              <h2>写一封，让人愿意读的邮件</h2>
                              <p>用变量称呼每一位收件人，预览会实时更新。</p>
                            </div>
                          </div>
                          <label className="field">
                            邮件主题 <span>{compose.subject.length}/300</span>
                            <input
                              value={compose.subject}
                              maxLength={300}
                              onChange={(e) => update({ subject: e.target.value })}
                              placeholder="例如：{{姓名}}，有一件好事想与你分享"
                            />
                          </label>
                          <div className="variable-bar">
                            <span>插入正文变量</span>
                            {(selectedList?.columns || ['姓名', '公司']).map((c) => (
                              <button
                                key={c}
                                onClick={() => update({ body: compose.body + `{{${c}}}` })}
                              >{`{ ${c} }`}</button>
                            ))}
                          </div>
                          <label className="field">
                            邮件正文
                            <textarea
                              className="mail-editor"
                              value={compose.body}
                              maxLength={30000}
                              onChange={(e) => update({ body: e.target.value })}
                              placeholder="你好，{{姓名}}！&#10;&#10;写下你想传递的话…"
                            />
                          </label>
                          <div className="editor-bottom">
                            <small>纯文本编辑 · 自动生成简洁邮件排版</small>
                            <button
                              className="text-button"
                              disabled={busy || !compose.subject.trim() || !compose.body.trim()}
                              onClick={() =>
                                run(async () => {
                                  await api('/templates', {
                                    method: 'POST',
                                    body: {
                                      name: compose.name,
                                      subject: compose.subject,
                                      body: compose.body,
                                    },
                                  });
                                  await refresh();
                                  setToast('已保存到我的模板');
                                })
                              }
                            >
                              <Stack size={16} />
                              存为模板
                            </button>
                          </div>
                        </>
                      )}
                      {step === 2 && (
                        <>
                          <div className="form-section-title">
                            <span>03</span>
                            <div>
                              <h2>按你的节奏，出发</h2>
                              <p>核对内容和账号后，安排真实发送。</p>
                            </div>
                          </div>
                          <div className="mode-cards">
                            {[['live', PaperPlaneTilt, '真实发送', '通过所选发件账号逐封发送']].map(
                              ([m, Icon, title, desc]) => (
                                <button
                                  key={m}
                                  className={'mode-card ' + (compose.mode === m ? 'selected' : '')}
                                  onClick={() => update({ mode: m })}
                                >
                                  <Icon size={24} />
                                  <div>
                                    <strong>{title}</strong>
                                    <small>{desc}</small>
                                  </div>
                                  <span className="radio-dot" />
                                </button>
                              ),
                            )}
                          </div>
                          {compose.mode === 'live' && !state.settings && (
                            <div className="warning-box">
                              <WarningCircle />
                              <p>
                                还没有配置发件账号。先保存草稿，再前往
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    run(async () => {
                                      await save();
                                      go('settings');
                                    })
                                  }
                                >
                                  发件设置
                                  <ArrowRight size={14} />
                                </button>
                                。
                              </p>
                            </div>
                          )}
                          {isMarketing && (
                            <div className="tip">
                              <PaperPlaneTilt />
                              <p>
                                由 Mailchimp
                                按营销活动批量投递，不使用逐封随机间隔。预约由本机提交，请保持电脑运行。
                              </p>
                            </div>
                          )}
                          {!isMarketing && (
                            <label className="field">
                              发送间隔
                              <select
                                value={compose.randomInterval !== false ? 'random' : 'fixed'}
                                onChange={(e) =>
                                  update({ randomInterval: e.target.value === 'random' })
                                }
                              >
                                <option value="random">随机间隔 · 30–120 秒</option>
                                <option value="fixed">固定速度</option>
                              </select>
                              <small>每封发送结束后重新随机等待 30–120 秒；首封立即发送。</small>
                            </label>
                          )}
                          {!isMarketing && compose.randomInterval === false && (
                            <label className="field">
                              固定速度
                              <select
                                value={compose.rate}
                                onChange={(e) => update({ rate: Number(e.target.value) })}
                              >
                                <option value={1}>每分钟 1 封</option>
                                <option value={5}>每分钟 5 封</option>
                                <option value={20}>每分钟 20 封</option>
                                <option value={60}>每分钟 60 封</option>
                              </select>
                            </label>
                          )}
                          <label className="field">
                            发送时间
                            <select
                              value={compose.scheduledAt === null ? 'now' : 'later'}
                              onChange={(e) =>
                                update({ scheduledAt: e.target.value === 'now' ? null : '' })
                              }
                            >
                              <option value="now">准备好后立即发送</option>
                              <option value="later">预约一个时间</option>
                            </select>
                          </label>
                          {compose.scheduledAt !== null && (
                            <label className="field">
                              预约时间（本机时区）
                              <input
                                type="datetime-local"
                                value={compose.scheduledAt ? toLocal(compose.scheduledAt) : ''}
                                onChange={(e) =>
                                  update({
                                    scheduledAt: e.target.value
                                      ? new Date(e.target.value).toISOString()
                                      : '',
                                  })
                                }
                              />
                              <small>预约生效需要保持平台服务运行。</small>
                            </label>
                          )}
                          <div className="tip">
                            <ShieldCheck />
                            <p>
                              真实发送的“成功”表示邮件服务器已接受，不等同于进入收件箱；请先向自己的邮箱发送测试邮件。
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="compose-footer">
                      <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
                        <ArrowLeft size={16} />
                        上一步
                      </Button>
                      {step < 2 ? (
                        <Button
                          kind="primary"
                          onClick={() => {
                            if (step === 0 && !compose.listId) {
                              setError('请先选择批量任务');
                              return;
                            }
                            if (step === 1 && (!compose.subject.trim() || !compose.body.trim())) {
                              setError('请填写邮件主题和正文');
                              return;
                            }
                            setStep(step + 1);
                          }}
                        >
                          下一步
                          <ArrowRight size={16} />
                        </Button>
                      ) : (
                        <Button
                          kind="primary"
                          disabled={busy}
                          onClick={() => {
                            if (
                              !compose.listId ||
                              !compose.subject.trim() ||
                              !compose.body.trim()
                            ) {
                              setError('请完成收件人、主题和正文');
                              return;
                            }
                            if (
                              compose.scheduledAt !== null &&
                              (!compose.scheduledAt ||
                                Date.parse(compose.scheduledAt) <= Date.now())
                            ) {
                              setError('请选择未来的预约时间');
                              return;
                            }
                            setLiveCheck(false);
                            setConfirm(true);
                          }}
                        >
                          检查并{compose.mode === 'simulation' ? '演练' : '发送'}
                          <ArrowRight size={16} />
                        </Button>
                      )}
                    </div>
                  </section>
                  <aside className="preview-column">
                    <div className="preview-heading">
                      <span>
                        <Eye size={18} />
                        收件人视角
                      </span>
                      <span className="live-preview">
                        <i />
                        实时预览
                      </span>
                    </div>
                    <div className="email-preview">
                      <div className="email-window">
                        <i />
                        <i />
                        <i />
                        <span>邮件预览</span>
                      </div>
                      <div className="email-meta">
                        <strong>{previewSubject}</strong>
                        <div>
                          <span className="sender-avatar">
                            <PaperPlaneTilt size={18} weight="fill" />
                          </span>
                          <p>
                            {state.accounts?.find((a) => a.id === compose?.accountId)?.name ||
                              '你的发件名称'}
                            <small>发送至 {recipient?.email || 'lin@example.com（示例）'}</small>
                          </p>
                        </div>
                      </div>
                      <div className="email-content">
                        <div className="email-brand">
                          <PaperPlaneTilt size={17} weight="fill" />
                          {state.accounts?.find((a) => a.id === compose?.accountId)?.name ||
                            '你的品牌'}
                        </div>
                        <div className="email-body">{previewBody}</div>
                      </div>
                    </div>
                    {selectedList && (
                      <div className="preview-pager">
                        <button
                          className="icon-button"
                          aria-label="上一位收件人"
                          disabled={!previewIndex}
                          onClick={() => setPreviewIndex(previewIndex - 1)}
                        >
                          <ArrowLeft size={16} />
                        </button>
                        <span>
                          第 {previewIndex + 1} / {selectedList.contacts.length} 位收件人
                        </span>
                        <button
                          className="icon-button"
                          aria-label="下一位收件人"
                          disabled={previewIndex >= selectedList.contacts.length - 1}
                          onClick={() => setPreviewIndex(previewIndex + 1)}
                        >
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    )}
                    <Button
                      className="full-width"
                      disabled={
                        !compose.accountId || !compose.subject.trim() || !compose.body.trim()
                      }
                      onClick={() => {
                        setTestAddress('');
                        setTestOpen(true);
                      }}
                    >
                      <EnvelopeSimple size={18} />
                      给自己发送测试邮件
                    </Button>
                    <p className="preview-footnote">测试邮件会真实发送至你指定的邮箱。</p>
                  </aside>
                </div>
              </>
            )}
          </main>
        </div>
        {importOpen && (
          <ImportModal
            busy={busy}
            run={run}
            onClose={() => setImportOpen(false)}
            onImported={async (l) => {
              await refresh();
              setImportOpen(false);
              if (l.batchId) {
                setCompose(null);
                go('reports');
                setToast(`已创建 ${l.campaignIds.length} 个任务，每账号最多10条，请核对后启动批次`);
                return;
              }
              if (compose && page === 'compose') update({ listId: l.id });
              else go('contacts');
              setToast(
                `已导入 ${l.contacts.length} 位收件人，排除 ${l.issues.length} 行异常数据；${l.preflight?.results?.filter((r) => r.status === 'warning').length || 0} 个邮箱需核查风险`,
              );
            }}
          />
        )}
        {confirm && (
          <Modal
            title={compose.mode === 'live' ? '确认真实发送' : '准备开始演练'}
            subtitle="最后检查一次，这封邮件即将出发。"
            onClose={() => !busy && setConfirm(false)}
          >
            <div className="review-summary">
              <div>
                <span>任务</span>
                <strong>{compose.name}</strong>
              </div>
              <div>
                <span>收件人</span>
                <strong>
                  {selectedList?.contacts.length || 0} 位 · {selectedList?.name}
                </strong>
              </div>
              <div>
                <span>邮件主题</span>
                <strong>{compose.subject}</strong>
              </div>
              <div>
                <span>发送模式</span>
                <Badge status={compose.mode === 'live' ? 'running' : 'draft'}>
                  {compose.mode === 'live' ? '真实发送' : '仅演练，不发送邮件'}
                </Badge>
              </div>
              <div>
                <span>开始时间</span>
                <strong>{compose.scheduledAt ? date(compose.scheduledAt) : '立即开始'}</strong>
              </div>
            </div>
            {isMarketing && (
              <div className="tip">
                <EnvelopeSimple />
                <p>
                  将创建约 {marketingCount} 个 Mailchimp Marketing 活动。正文按原文提交，Mailchimp
                  会加入退订链接和 Audience
                  的实体地址页脚；仅对订阅联系人发送。活动提交后，本地暂停或取消不能撤回 Mailchimp
                  已接收的活动。
                </p>
              </div>
            )}
            {compose.mode === 'live' && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={liveCheck}
                  onChange={(e) => setLiveCheck(e.target.checked)}
                />
                {isMarketing
                  ? '我已核对内容、收件人和 Marketing 页脚，确认创建并发送这些营销活动。'
                  : '我已核对内容和批量任务，确认发送这些邮件。'}
              </label>
            )}
            <div className="modal-actions">
              <Button onClick={() => setConfirm(false)} disabled={busy}>
                返回修改
              </Button>
              <Button
                kind="primary"
                disabled={busy || (compose.mode === 'live' && !liveCheck)}
                onClick={() =>
                  run(async () => {
                    const c = await save();
                    const result = await api('/campaigns/' + c.id + '/action', {
                      method: 'POST',
                      body: {
                        action: 'start',
                        confirmLive: liveCheck,
                        marketingFooterAccepted: isMarketing && liveCheck,
                      },
                    });
                    setConfirm(false);
                    setCompose(null);
                    setDetail(result);
                    go('campaigns');
                    await refresh();
                    setToast(compose.mode === 'simulation' ? '演练任务已启动' : '发送任务已启动');
                  })
                }
              >
                {busy ? <SpinnerGap className="spin" /> : <PaperPlaneTilt />}
                {compose.mode === 'live' ? '确认发送' : '开始演练'}
              </Button>
            </div>
          </Modal>
        )}
        {testOpen && (
          <Modal
            title="发送一封测试邮件"
            subtitle="发送当前预览内容，先看看实际收到的效果。"
            onClose={() => !busy && setTestOpen(false)}
          >
            <label className="field">
              接收测试邮件的邮箱
              <input
                type="email"
                value={testAddress}
                onChange={(e) => setTestAddress(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <div className="tip">
              <EnvelopeSimple />
              <p>
                {isMarketing
                  ? '将创建一个 Mailchimp 测试草稿并向此邮箱发送测试邮件，包含 Marketing 页脚；不会群发给 Audience。'
                  : '将通过已配置账号真实发送 1 封邮件。'}
              </p>
            </div>
            <div className="modal-actions">
              <Button onClick={() => setTestOpen(false)}>取消</Button>
              <Button
                kind="primary"
                disabled={busy || !testAddress}
                onClick={() =>
                  run(async () => {
                    const result = await api('/test-email', {
                      method: 'POST',
                      body: {
                        accountId: compose.accountId,
                        to: testAddress,
                        subject: '[测试] ' + previewSubject,
                        body: previewBody,
                      },
                    });
                    setTestOpen(false);
                    setToast(
                      result.queued
                        ? '测试邮件已加入发送队列，可在草稿箱查看进度'
                        : '测试邮件已被服务器接受，请检查邮箱',
                    );
                  })
                }
              >
                发送测试邮件
              </Button>
            </div>
          </Modal>
        )}
        {detail && (
          <TaskDetail
            onFollowup={() => {
              setFollowupView(null);
              setFollowupCampaign(detail.id);
              setDetail(null);
              setPage('followup');
            }}
            detail={detail}
            busy={busy}
            onClose={() => setDetail(null)}
            onRetryRow={(r) =>
              run(async () => {
                await api(`/campaigns/${detail.id}/recipients/${r.id}/retry`, {
                  method: 'POST',
                  body: { confirmLive: true, confirmUncertain: true },
                });
                setDetail(await api('/campaigns/' + detail.id));
                await refresh();
              })
            }
            onAction={action}
          />
        )}
        {listDetail && (
          <Modal
            title={listDetail.deleting ? '删除这份批量任务？' : listDetail.name}
            subtitle={
              listDetail.deleting
                ? '已创建任务中的收件人快照会保留。'
                : `${listDetail.contacts.length} 位可用收件人 · ${listDetail.issues.length} 行已排除`
            }
            onClose={() => setListDetail(null)}
            wide={!listDetail.deleting}
          >
            {listDetail.deleting ? (
              <>
                <p>确定删除「{listDetail.name}」？此操作无法撤销。</p>
                <div className="modal-actions">
                  <Button onClick={() => setListDetail(null)}>取消</Button>
                  <Button
                    kind="danger"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api('/lists/' + listDetail.id, { method: 'DELETE' });
                        setListDetail(null);
                        await refresh();
                        setToast('批量任务已删除');
                      })
                    }
                  >
                    删除批量任务
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="table-wrap modal-table">
                  <table>
                    <thead>
                      <tr>
                        <th>邮箱</th>
                        {listDetail.columns
                          .filter((c) => c !== listDetail.emailColumn)
                          .slice(0, 4)
                          .map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {listDetail.contacts.slice(0, 100).map((r) => (
                        <tr key={r.id}>
                          <td>{r.email}</td>
                          {listDetail.columns
                            .filter((c) => c !== listDetail.emailColumn)
                            .slice(0, 4)
                            .map((c) => (
                              <td key={c}>{r.fields[c] || '未填写'}</td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="modal-actions split">
                  <small>预览前 100 封邮件；发送将使用完整批量任务。</small>
                  {!!listDetail.preflight?.results?.filter((r) => r.status === 'warning')
                    .length && (
                    <details>
                      <summary>邮箱预检风险（不代表无效）</summary>
                      {listDetail.preflight.results
                        .filter((r) => r.status === 'warning')
                        .map((r) => (
                          <p key={r.email}>
                            {r.email}：{r.reason}
                          </p>
                        ))}
                    </details>
                  )}
                  {!!listDetail.issues.length && (
                    <a className="button" href={'/api/lists/' + listDetail.id + '/issues'} download>
                      <DownloadSimple size={16} />
                      导出异常行
                    </a>
                  )}
                </div>
              </>
            )}
          </Modal>
        )}
        {error && (
          <div className="toast error" role="alert">
            <WarningCircle />
            <span>{error}</span>
            <button aria-label="关闭错误提示" onClick={() => setError('')}>
              <X size={18} />
            </button>
          </div>
        )}
        {toast && !error && (
          <div className="toast" role="status">
            <CheckCircle weight="fill" />
            <span>{toast}</span>
            <button aria-label="关闭提示" onClick={() => setToast('')}>
              <X size={18} />
            </button>
          </div>
        )}
      </div>
    </IconContext.Provider>
  );
}
function PageTitle({ eyebrow, title, desc, action }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>
          {title}
          <span className="heading-dot">.</span>
        </h1>
        <p>{desc}</p>
      </div>
      {action}
    </div>
  );
}
function Search({ value, onChange, placeholder }) {
  return (
    <label className="search">
      <MagnifyingGlass size={17} />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
function toLocal(s) {
  const d = new Date(s);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function TemplateCard({ preset: p, onUse }) {
  return (
    <button className={'template-card ' + p.color} onClick={onUse}>
      <div className="template-card-top">
        <span>{p.tag}</span>
        <ArrowUpRight size={18} />
      </div>
      <div className="template-mini-mail" aria-hidden="true">
        <div className="mini-mail-head">
          <span />
          <i />
          <i />
        </div>
        <div className="mini-mail-salute">
          Hi, <mark>{'{{姓名}}'}</mark>
        </div>
        <i />
        <i />
        <i className="short" />
      </div>
      <h3>{p.name}</h3>
      <span className="template-use">
        使用这个模板
        <ArrowRight size={15} />
      </span>
    </button>
  );
}
function ImportModal({ onClose, onImported, busy, run }) {
  const [data, setData] = useState(null),
    [sheetIndex, setSheetIndex] = useState(0),
    [emailColumn, setEmailColumn] = useState(''),
    [subjectColumn, setSubjectColumn] = useState(''),
    [bodyColumn, setBodyColumn] = useState(''),
    [autoGroup, setAutoGroup] = useState(true),
    [accounts, setAccounts] = useState([]),
    [accountIds, setAccountIds] = useState([]),
    [requestId, setRequestId] = useState(() => clientId()),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [drag, setDrag] = useState(false),
    [addressReview, setAddressReview] = useState(null);
  useEffect(() => {
    setRequestId(clientId());
  }, [
    name,
    description,
    sheetIndex,
    emailColumn,
    subjectColumn,
    bodyColumn,
    accountIds,
    autoGroup,
  ]);
  const fileRef = useRef();
  const sheet = data?.sheets[sheetIndex];
  useEffect(() => {
    setAddressReview(null);
  }, [data, sheetIndex, emailColumn]);
  useEffect(() => {
    api('/import-accounts').then((a) => {
      setAccounts(a);
      setAccountIds(a.map((v) => v.id));
    });
  }, []);
  function chooseSheet(i, d = data) {
    setSheetIndex(i);
    setRequestId(clientId());
    setSubjectColumn(
      d.sheets[i].columns.find((c) => /^(email_subject|subject|标题|邮件标题)$/i.test(c)) || '',
    );
    setBodyColumn(
      d.sheets[i].columns.find((c) => /^(email_content|body|content|正文|邮件正文)$/i.test(c)) ||
        '',
    );
    setEmailColumn(
      d.sheets[i].columns.find((c) => /email|e-mail|邮箱|邮件地址/i.test(c)) ||
        d.sheets[i].columns[0],
    );
  }
  function upload(file) {
    if (!file) return;
    run(async () => {
      const fd = new FormData();
      fd.append('file', file);
      const d = await api('/import', { method: 'POST', body: fd });
      setData(d);
      setName(file.name.replace(/\.[^.]+$/, ''));
      chooseSheet(0, d);
    });
  }
  const quality = sheet
    ? (() => {
        const seen = new Set();
        let bad = 0,
          duplicate = 0;
        sheet.rows.forEach((r) => {
          const s = (r[emailColumn] || '').trim().toLowerCase();
          if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(s) || s.length > 254) bad++;
          else if (seen.has(s)) duplicate++;
          else seen.add(s);
        });
        return { valid: seen.size, bad, duplicate };
      })()
    : null;
  return (
    <Modal
      title="导入批量任务"
      subtitle="导入批量任务，检查字段，准备下一次沟通。"
      onClose={() => !busy && onClose()}
      wide
    >
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.csv"
        hidden
        onChange={(e) => upload(e.target.files[0])}
      />
      {!data ? (
        <>
          <button
            className={'dropzone ' + (drag ? 'drag' : '')}
            disabled={busy}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              upload(e.dataTransfer.files[0]);
            }}
            onClick={() => fileRef.current.click()}
          >
            <span className="upload-graphic">
              {busy ? <SpinnerGap className="spin" size={34} /> : <FileXls size={38} />}
            </span>
            <h3>{busy ? '正在读取你的表格…' : '将表格拖到这里，或点击选择'}</h3>
            <p>Excel (.xlsx) / UTF-8 CSV · 最大 5 MB · 最多 10,000 行</p>
          </button>
          <div className="import-instructions">
            <div>
              <span>01</span>
              <p>
                第一行是表头
                <br />
                <small>例如：邮箱、标题、正文</small>
              </p>
            </div>
            <div>
              <span>02</span>
              <p>
                每行一位收件人
                <br />
                <small>自动分组需要邮箱、标题、正文三列</small>
              </p>
            </div>
            <div>
              <span>03</span>
              <p>
                自动检查与去重
                <br />
                <small>无效邮箱所在行不会进入批量任务</small>
              </p>
            </div>
          </div>
          <div className="modal-actions split">
            <span className="muted">
              每行一封邮件；默认每10条分配一个账号，标题和正文原样发送。
            </span>
            <a className="button" href="/api/sample" download>
              <DownloadSimple size={17} />
              下载示例 CSV
            </a>
          </div>
        </>
      ) : (
        <>
          <div className="form-row">
            <label className="field">
              任务名称（说明用途）
              <input
                value={name}
                maxLength={100}
                onChange={(e) => {
                  setName(e.target.value);
                  setRequestId(clientId());
                }}
              />
            </label>
            <label className="field">
              工作表
              <select value={sheetIndex} onChange={(e) => chooseSheet(Number(e.target.value))}>
                {data.sheets.map((s, i) => (
                  <option key={i} value={i}>
                    {s.name}（{s.rows.length} 行）
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            用途说明（可选）
            <textarea
              value={description}
              maxLength={500}
              onChange={(e) => {
                setDescription(e.target.value);
                setRequestId(clientId());
              }}
            />
          </label>
          <label className="field">
            哪一列是收件邮箱？
            <select value={emailColumn} onChange={(e) => setEmailColumn(e.target.value)}>
              {sheet.columns.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={autoGroup}
              onChange={(e) => {
                setAutoGroup(e.target.checked);
                setRequestId(clientId());
              }}
            />
            默认每10条分配一个发件账号，自动创建同一批次的任务（不添加副本）
          </label>
          {autoGroup && (
            <>
              <div className="form-row">
                {[
                  ['标题', subjectColumn, setSubjectColumn],
                  ['正文', bodyColumn, setBodyColumn],
                ].map(([label, value, set]) => (
                  <label className="field" key={label}>
                    {label}列
                    <select
                      value={value}
                      onChange={(e) => {
                        set(e.target.value);
                        setRequestId(clientId());
                      }}
                    >
                      <option value="">请选择</option>
                      {sheet.columns.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p>
                预计 {Math.ceil(quality.valid / 10)} 组 · 最多3个账号并行 · 标题与正文按列原样使用
              </p>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
                  gap: 8,
                  marginBottom: 16,
                }}
              >
                {accounts.map((a) => (
                  <label key={a.id}>
                    <input
                      type="checkbox"
                      checked={accountIds.includes(a.id)}
                      onChange={(e) => {
                        setAccountIds(
                          e.target.checked
                            ? [...accountIds, a.id]
                            : accountIds.filter((id) => id !== a.id),
                        );
                        setRequestId(clientId());
                      }}
                    />{' '}
                    {a.email}
                  </label>
                ))}
              </div>
              <small>
                按勾选账号顺序分配，每账号本批最多10条。已选 {accountIds.length}{' '}
                个；不足时请先绑定并测试账号，或减少导入条数。导入不会直接发送。
              </small>
            </>
          )}
          <div className="import-quality">
            <span>
              <strong>{num(quality.valid)}</strong>格式通过（待预检）
            </span>
            <span>
              <strong>{num(quality.duplicate)}</strong>重复邮箱
            </span>
            <span>
              <strong>{num(quality.bad)}</strong>无效邮箱
            </span>
          </div>
          <div className="table-wrap import-preview">
            <table>
              <thead>
                <tr>
                  {sheet.columns.slice(0, 5).map((c) => (
                    <th key={c}>
                      {c}
                      {c === emailColumn && <span className="column-tag">邮箱</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {sheet.columns.slice(0, 5).map((c) => (
                      <td key={c}>{r[c] || '空'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small className="muted">
            预览前 5 行。无效和重复邮箱会自动排除，导入后可下载异常报告。
          </small>
          <div className="panel" style={{ padding: 16, marginTop: 16 }}>
            <strong>邮箱地址预检</strong>
            <p className="muted">
              检查格式、历史停发记录及域名路由；不会发送验证邮件。未发现问题不代表保证送达。
            </p>
            <Button
              disabled={busy || !emailColumn}
              onClick={() =>
                run(async () => {
                  setAddressReview(
                    await api('/address-preflight', {
                      method: 'POST',
                      body: {
                        name: name.trim() || '地址预检',
                        rows: sheet.rows,
                        emailColumn,
                      },
                    }),
                  );
                })
              }
            >
              {addressReview ? '重新检查地址' : '检查地址'}
            </Button>
            {addressReview && (
              <>
                <p>
                  明确无效 {addressReview.counts.invalid} 个 · 存在风险{' '}
                  {addressReview.counts.warning} 个 · 暂未发现问题 {addressReview.counts.clear}{' '}
                  个（按唯一邮箱统计）
                </p>
                <details>
                  <summary>查看预检明细</summary>
                  <div style={{ maxHeight: 240, overflow: 'auto' }}>
                    {addressReview.results.map((r) => (
                      <p key={r.email}>
                        {r.email || '空邮箱'}：{r.reason}
                      </p>
                    ))}
                  </div>
                </details>
              </>
            )}
            <small className="muted">
              导入时会再次检查。明确无效的记录将排除并保留原字段，风险记录仍可导入。
            </small>
          </div>
          <div className="modal-actions">
            <Button
              disabled={busy}
              onClick={() => {
                setData(null);
                fileRef.current.value = '';
              }}
            >
              重新选择
            </Button>
            <Button
              kind="primary"
              disabled={
                busy ||
                !quality.valid ||
                !name.trim() ||
                (autoGroup && (!subjectColumn || !bodyColumn || !accountIds.length))
              }
              onClick={() =>
                run(async () => {
                  const l = await api(autoGroup ? '/import-batch' : '/lists', {
                    method: 'POST',
                    body: {
                      name,
                      description,
                      sourceFileName: data.sourceFileName,
                      sheetName: sheet.name,
                      requestId,
                      rows: sheet.rows,
                      emailColumn,
                      ...(autoGroup ? { subjectColumn, bodyColumn, accountIds, requestId } : {}),
                    },
                  });
                  await onImported(l);
                })
              }
            >
              {busy ? <SpinnerGap className="spin" /> : <Check />}导入并过滤 {num(quality.valid)}{' '}
              个候选邮箱
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
function TaskDetail({ detail: c, onClose, onAction, onFollowup, busy, onRetryRow }) {
  const [q, setQ] = useState(''),
    [filter, setFilter] = useState('all'),
    [confirmAction, setConfirmAction] = useState('');
  const counts = c.recipients.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}),
    done = (counts.sent || 0) + (counts.simulated || 0) + (counts.failed || 0),
    rows = c.recipients.filter(
      (r) => (filter === 'all' || r.status === filter) && r.email.includes(q),
    );
  return (
    <Modal
      title={c.name}
      subtitle={`${c.mode === 'simulation' ? '演练任务 · 不发送真实邮件' : '真实发送任务'} · ${c.listName}`}
      onClose={onClose}
      wide
    >
      <div className="task-detail-summary">
        <Badge status={c.status} />
        <span>
          {c.scheduledAt && c.status === 'scheduled'
            ? `预约 ${date(c.scheduledAt)}`
            : `${num(c.recipients.length)} 位收件人`}
        </span>
        <a className="button" href={'/api/campaigns/' + c.id + '/export'} download>
          <DownloadSimple size={16} />
          导出结果
        </a>
      </div>
      {c.marketing && (
        <section className="panel" style={{ padding: 16, marginBottom: 16 }}>
          <h3>Mailchimp Marketing 活动</h3>
          <p>
            已提交仅表示 Mailchimp
            接受活动；同步后可查看发送状态和汇总报告。暂停或取消仅阻止尚未提交的活动。
          </p>
          {c.marketing.groups.map((g, i) => (
            <p key={i}>
              活动 {i + 1} · {g.remoteId || '尚未生成 ID'} · {g.remoteStatus || g.status}
              {g.report
                ? ` · 发出 ${g.report.emailsSent || 0} · 硬退信 ${g.report.hardBounces || 0} · 软退信 ${g.report.softBounces || 0} · 退订 ${g.report.unsubscribed || 0}`
                : ''}
              {g.error ? ` · ${g.error}` : ''}
            </p>
          ))}
          <Button
            disabled={busy || ['running', 'scheduled'].includes(c.status)}
            onClick={() => onAction(c, 'marketing-sync')}
          >
            同步活动状态与报告
          </Button>
          <a
            className="button"
            href="https://admin.mailchimp.com/campaigns/"
            target="_blank"
            rel="noreferrer"
          >
            前往 Mailchimp
          </a>
        </section>
      )}
      <div className="detail-metrics">
        <div>
          <strong>{done}</strong>
          <span>已处理</span>
        </div>
        <div>
          <strong>{(counts.sent || 0) + (counts.simulated || 0)}</strong>
          <span>{c.mode === 'simulation' ? '演练完成' : '发送服务已接受'}</span>
        </div>
        <div>
          <strong>{counts.failed || 0}</strong>
          <span>发送失败</span>
        </div>
        <div>
          <strong>{(counts.uncertain || 0) + (counts.needs_review || 0)}</strong>
          <span>需要核对</span>
        </div>
      </div>
      <div className="progress-track">
        <i style={{ width: `${c.recipients.length ? (done / c.recipients.length) * 100 : 0}%` }} />
      </div>
      {c.mode === 'live' && (
        <div className="follow-help">
          <strong>发送结果与后续跟踪分开记录</strong>
          <button className="button" onClick={onFollowup}>
            查看相关回复与退信
          </button>
          <p>
            {c.tracking?.until
              ? `回复跟踪至 ${date(c.tracking.until)}，在「回复与跟进」查看新消息或延长期限。`
              : '发送后默认持续跟踪 14 天，可在「回复与跟进」管理。'}{' '}
            已发送不代表进入对方收件箱。
          </p>
        </div>
      )}
      {!!counts.uncertain && (
        <div className="warning-box">
          <WarningCircle />
          <p>
            部分邮件正在自动核对发件箱，其他邮件继续发送。核对后仍无法确认的邮件需要人工确认重发。
          </p>
        </div>
      )}
      <div className="toolbar compact">
        <select
          aria-label="筛选收件人状态"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部收件人</option>
          {[
            'pending',
            'retry_wait',
            'sent',
            'simulated',
            'failed',
            'uncertain',
            'needs_review',
            'cancelled',
          ].map((s) => (
            <option key={s} value={s}>
              {statusText[s]}
            </option>
          ))}
        </select>
        <Search value={q} onChange={setQ} placeholder="搜索收件邮箱" />
      </div>
      <div className="table-wrap modal-table">
        <table>
          <thead>
            <tr>
              <th>收件邮箱</th>
              <th>发送状态</th>
              <th>备注 / 时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((r) => (
              <tr key={r.id}>
                <td>{r.email}</td>
                <td>
                  <Badge status={r.resolvedBy ? 'sent' : r.status} />
                  {r.deliveryStatus === 'bounced' && (
                    <small className="follow-kind bounce">已退信</small>
                  )}
                  {r.lastReplyAt && <small className="follow-kind reply">已有回复</small>}
                  {r.sentEvidence && <small className="muted"> · 已发送箱有记录</small>}
                </td>
                <td className="result-note">
                  {r.attempts?.length > 0 && (
                    <details>
                      <summary>发送尝试 {r.attempts.length} 次</summary>
                      {r.attempts.map((a, i) => (
                        <p key={i}>
                          {date(a.startedAt)} · {statusText[a.status] || a.status} · {a.error || ''}
                        </p>
                      ))}
                    </details>
                  )}
                  {r.retryAt && r.status === 'retry_wait' && <p>下次重试：{date(r.retryAt)}</p>}
                  {r.reconcileAt && r.status === 'uncertain' && (
                    <p>下次核对：{date(r.reconcileAt)}</p>
                  )}
                  {['failed', 'needs_review'].includes(r.status) && !r.resolvedBy && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            r.failureKind === 'unknown'
                              ? '请先核对发件箱。确认仍要重发？可能产生重复邮件，原文保持不变。'
                              : '确认重试此邮件？将发送真实邮件。',
                          )
                        )
                          onRetryRow(r);
                      }}
                    >
                      确认重试此邮件
                    </button>
                  )}
                  {r.resolvedBy && <p>已关联成功补发，计入原批次</p>}
                  {r.error ||
                    (r.providerStatus
                      ? `Mailchimp：${{ sent: '已提交', queued: '服务商排队中', scheduled: '服务商已预约' }[r.providerStatus] || r.providerStatus} · ${date(r.sentAt)}`
                      : date(r.sentAt))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="no-results">没有匹配的收件人</p>}
      </div>
      <small className="muted">显示前 100 条匹配结果，完整记录请导出。</small>
      {confirmAction ? (
        <div className="action-confirm">
          <p>
            {confirmAction === 'return_pool'
              ? '确认将尚未发送的邮件退回未排期？旧任务保留历史，不会自动发送；结果不明的邮件仍需核对。'
              : confirmAction === 'cancel'
                ? c.marketing
                  ? '取消会停止尚未提交的活动；Mailchimp 已接收的活动仍可能继续投递。'
                  : '取消后，尚未发送的邮件将停止发送。正在提交的一封可能仍会完成。'
                : `确认${confirmAction === 'retry' ? '重试失败的邮件' : '继续这个任务'}？${c.mode === 'live' ? '这会发送真实邮件。' : ''}`}
          </p>
          <Button onClick={() => setConfirmAction('')}>返回</Button>
          <Button
            kind={confirmAction === 'cancel' ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => {
              onAction(c, confirmAction);
              setConfirmAction('');
            }}
          >
            确认操作
          </Button>
        </div>
      ) : (
        <div className="modal-actions">
          {['running', 'scheduled'].includes(c.status) && (
            <Button disabled={busy} onClick={() => setConfirmAction('return_pool')}>
              <Pause />
              退回未排期
            </Button>
          )}
          {c.status === 'paused' && (
            <Button disabled={busy} kind="primary" onClick={() => setConfirmAction('return_pool')}>
              <Play />
              退回未排期
            </Button>
          )}
          {['completed_errors', 'cancelled'].includes(c.status) && !!counts.failed && (
            <Button disabled={busy} onClick={() => setConfirmAction('retry')}>
              仅重试失败邮件
            </Button>
          )}
          {['running', 'scheduled', 'paused'].includes(c.status) && (
            <Button disabled={busy} kind="danger-ghost" onClick={() => setConfirmAction('cancel')}>
              取消任务
            </Button>
          )}
          <Button onClick={onClose}>关闭</Button>
        </div>
      )}
    </Modal>
  );
}
function Settings({ initial, accounts, busy, run, refresh, notify }) {
  const [accountId, setAccountId] = useState(initial?.id || '');
  const [passwordHelp, setPasswordHelp] = useState(false);
  const accountForm = useRef(null);
  function selectAccount(id) {
    const a = accounts.find((a) => a.id === id);
    setAccountId(id);
    setAudiences([]);
    setForm({
      provider: a?.provider || 'smtp',
      server: a?.server || '',
      audienceId: a?.audienceId || '',
      name: a?.name || '',
      from: a?.from || '',
      host: a?.host || 'smtp.gmail.com',
      port: a?.port || 465,
      secure: a?.secure ?? true,
      user: a?.user || '',
      password: '',
      dailyCap: a?.dailyCap ?? '',
    });
    setVerified(false);
    setDomainWarnings(a?.domainCheck?.warnings || []);
  }
  const [form, setForm] = useState({
      provider: initial?.provider || 'smtp',
      server: initial?.server || '',
      audienceId: initial?.audienceId || '',
      name: initial?.name || '',
      from: initial?.from || '',
      host: initial?.host || 'smtp.gmail.com',
      port: initial?.port || 465,
      secure: initial?.secure ?? true,
      user: initial?.user || '',
      password: '',
      dailyCap: initial?.dailyCap ?? '',
    }),
    [verified, setVerified] = useState(false),
    [domainWarnings, setDomainWarnings] = useState(initial?.domainCheck?.warnings || []);
  const [audiences, setAudiences] = useState([]);
  const isMarketing = form.provider === 'mailchimp-marketing';
  const isMailchimp = form.provider === 'mailchimp';
  const hasSecret = accounts.find((a) => a.id === accountId)?.hasPassword;
  function change(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
    setVerified(false);
  }
  async function save() {
    if (!accountForm.current.reportValidity()) throw new Error('请补齐表单中的必填项');
    const from = form.from.trim();
    const cap = Number(form.dailyCap);
    const body = {
      ...form,
      from,
      name: form.name.trim() || from.split('@')[0].slice(0, 80),
      // Empty means "let the warm-up ramp decide"; the server still hard-caps at 200.
      dailyCap: Number.isFinite(cap) && cap >= 1 ? Math.min(200, Math.round(cap)) : undefined,
      ...(!isMarketing && !isMailchimp ? { user: form.user.trim() || from } : {}),
    };
    const saved = await api(accountId ? '/accounts/' + accountId : '/accounts', {
      method: accountId ? 'PUT' : 'POST',
      body,
    });
    setAccountId(saved.id);
    setForm((f) => ({ ...f, password: '' }));
    await refresh();
    return saved.id;
  }
  return (
    <>
      <PageTitle
        eyebrow="SENDING SETTINGS"
        title="为邮件，准备一个出发点"
        desc="保存多个发件账号，创建批量发送任务时选择使用哪个账号。"
      />
      <section className="panel" style={{ padding: 24, marginBottom: 20 }}>
        <label className="field">
          管理发件账号
          <select value={accountId} onChange={(e) => selectAccount(e.target.value)}>
            <option value="">新增发件账号</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.disabled ? '【不可用】' : ''}
                {a.replyOnly ? '【只做回复用】' : ''}
                {a.name} · {a.from} ·{' '}
                {a.provider === 'mailchimp-marketing'
                  ? 'Mailchimp Marketing'
                  : a.provider === 'mailchimp'
                    ? 'Transactional'
                    : 'SMTP'}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => selectAccount('')}>新增账号</Button>
        {accountId && (
          <div style={{ marginTop: 16 }}>
            {accounts.find((a) => a.id === accountId)?.replyOnly && (
              <p>只做回复用：可人工回复或写邮件，不参与批量发送。</p>
            )}
            <p>
              {accounts.find((a) => a.id === accountId)?.disabled
                ? '不可用：' +
                  (accounts.find((a) => a.id === accountId)?.disabledReason || '手动停用')
                : '账号可用'}
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const disabled = !accounts.find((a) => a.id === accountId)?.disabled;
                  await api('/accounts/' + accountId + '/availability', {
                    method: 'PATCH',
                    body: { disabled, reason: '手动停用' },
                  });
                  await refresh();
                  notify(
                    disabled
                      ? '账号已设为不可用，历史记录保留'
                      : '账号已恢复可用；原任务需手动恢复',
                  );
                })
              }
            >
              {accounts.find((a) => a.id === accountId)?.disabled ? '恢复可用' : '设为不可用'}
            </Button>
            {(() => {
              const current = accounts.find((a) => a.id === accountId);
              if (!current) return null;
              return (
                <p className="account-quota">
                  今日已发 <strong>{current.sentToday ?? 0}</strong> 封 · 上限{' '}
                  <strong>{current.dailyCap ?? 200}</strong> 封（新加坡时间 0 点重置）
                </p>
              );
            })()}
          </div>
        )}
      </section>
      <div className="settings-layout">
        <section className="panel settings-panel">
          <div className="section-heading">
            <div>
              <h2>发件账号</h2>
              <p>选择 SMTP 邮箱或 Mailchimp Marketing 营销发送渠道。</p>
            </div>
            <span className="settings-icon">
              <EnvelopeSimple size={24} />
            </span>
          </div>
          <form
            ref={accountForm}
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await save();
                notify('发件设置已加密保存');
              });
            }}
          >
            <label className="field">
              发送渠道（必选）
              <select
                value={form.provider}
                disabled={!!accountId}
                onChange={(e) => {
                  change('provider', e.target.value);
                  change('password', '');
                }}
              >
                <option value="smtp">SMTP 邮箱</option>
                <option value="mailchimp-marketing">Mailchimp Marketing（营销活动）</option>
                {isMailchimp && (
                  <option value="mailchimp">Mailchimp Transactional（旧渠道）</option>
                )}
              </select>
              {accountId && <small>更换渠道请新增账号。</small>}
            </label>
            {isMarketing && (
              <div className="tip">
                <EnvelopeSimple />
                <p>
                  使用 Mailchimp Marketing 账号创建营销活动，无需开通 Mandrill。先填写 API Key
                  和服务器前缀，再读取并选择 Audience。
                </p>
              </div>
            )}
            {isMailchimp && (
              <div className="tip">
                <EnvelopeSimple />
                <p>
                  适用于交易通知等邮件，需开通 Transactional 服务并认证自有发件域名。营销群发请使用
                  Mailchimp
                  Marketing；公开搜集的名单不能直接导入群发。此渠道以纯文本提交标题和正文。
                </p>
              </div>
            )}
            <div className="form-row">
              <label className="field">
                发件人名称（选填）
                <input
                  maxLength={80}
                  value={form.name}
                  onChange={(e) => change('name', e.target.value)}
                  placeholder="留空使用邮箱 @ 前的名称"
                />
                <small>收件人会看到的名称；可由后续配置人员修改。</small>
              </label>
              <label className="field">
                发件邮箱（必填）
                <input
                  required
                  type="email"
                  value={form.from}
                  onChange={(e) => change('from', e.target.value)}
                  placeholder="hello@yourcompany.com"
                />
              </label>
            </div>
            {!isMailchimp && !isMarketing && (
              <>
                <div className="form-row host-row">
                  <label className="field">
                    SMTP 服务器（必填{form.host === 'smtp.gmail.com' ? '，已预填 Gmail' : ''}）
                    <input
                      required
                      value={form.host}
                      onChange={(e) => change('host', e.target.value)}
                      placeholder="smtp.example.com"
                    />
                  </label>
                  <label className="field">
                    端口（必填，已预填）
                    <input
                      required
                      type="number"
                      min={1}
                      max={65535}
                      value={form.port}
                      onChange={(e) => change('port', Number(e.target.value))}
                    />
                  </label>
                </div>
                <label className="field">
                  加密方式（已预选）
                  <select
                    value={form.secure ? 'tls' : 'starttls'}
                    onChange={(e) => {
                      change('secure', e.target.value === 'tls');
                      change('port', e.target.value === 'tls' ? 465 : 587);
                    }}
                  >
                    <option value="tls">SSL / TLS（通常为 465 端口）</option>
                    <option value="starttls">STARTTLS（通常为 587 端口）</option>
                  </select>
                  <small>
                    Gmail 可沿用服务器、465 端口和 SSL / TLS；其他邮箱请按服务商要求修改。
                  </small>
                </label>
                <label className="field">
                  SMTP 登录账号（选填）
                  <input
                    autoComplete="username"
                    value={form.user}
                    onChange={(e) => change('user', e.target.value)}
                    placeholder="留空使用上方的发件邮箱"
                  />
                  <small>仅当服务商要求使用不同的登录账号时填写。</small>
                </label>
              </>
            )}
            <div className="field">
              <div className="account-secret-heading">
                <label htmlFor="account-secret">
                  {isMarketing
                    ? 'Marketing API Key'
                    : isMailchimp
                      ? 'Transactional API Key'
                      : '邮箱授权码 / 应用密码'}
                  {hasSecret ? '（选填，留空保留原密码）' : '（必填）'}
                </label>
                {!isMarketing && !isMailchimp && (
                  <button
                    type="button"
                    className="account-help-button"
                    aria-label="如何获取 Gmail 应用密码"
                    title="如何获取 Gmail 应用密码"
                    aria-haspopup="dialog"
                    onClick={() => setPasswordHelp(true)}
                  >
                    <Question size={20} />
                  </button>
                )}
              </div>
              <input
                id="account-secret"
                type="password"
                autoComplete="new-password"
                required={!hasSecret}
                value={form.password}
                onChange={(e) => {
                  change('password', e.target.value);
                  if (isMarketing) {
                    const dc = e.target.value.trim().match(/-(us\d{1,4})$/);
                    if (dc) change('server', dc[1]);
                  }
                }}
                placeholder={
                  hasSecret
                    ? '已加密保存，留空保留原凭证'
                    : isMarketing
                      ? '输入 Mailchimp Marketing API Key'
                      : isMailchimp
                        ? '输入 Transactional API Key'
                        : '输入邮箱授权码或应用密码'
                }
              />
              <small>
                {isMarketing
                  ? '在 Mailchimp 账户设置中生成，末尾如 -us21 可自动识别服务器前缀。'
                  : isMailchimp
                    ? '使用 Mandrill 后台的 API Key，不能使用 Marketing API Key 或 Gmail 密码。'
                    : '填写服务商生成的授权码或应用密码。Gmail 获取方法见旁边的问号。'}
              </small>
            </div>
            {isMarketing && (
              <>
                <label className="field">
                  服务器前缀（必填，可从 API Key 自动识别）
                  <input
                    value={form.server}
                    required
                    placeholder="例如 us21"
                    onChange={(e) => change('server', e.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const id = await save();
                      const list = await api('/accounts/' + id + '/audiences');
                      setAudiences(list);
                      notify(
                        list.length
                          ? '受众列表已读取，请选择并保存'
                          : '此账号尚无 Audience，请先在 Mailchimp 创建受众',
                      );
                    })
                  }
                >
                  保存凭证并读取 Audience
                </Button>
                <label className="field">
                  Audience（受众，保存账号时可暂不选）
                  <select
                    value={form.audienceId}
                    onChange={(e) => change('audienceId', e.target.value)}
                  >
                    <option value="">请先读取并选择受众</option>
                    {form.audienceId && !audiences.some((a) => a.id === form.audienceId) && (
                      <option value={form.audienceId}>{form.audienceId}（已保存）</option>
                    )}
                    {audiences.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.count} 位订阅联系人
                      </option>
                    ))}
                  </select>
                  <small>
                    开始发送前必须选择并保存。发送只使用任务名单中的联系人，不会向整个 Audience
                    群发。
                  </small>
                </label>
              </>
            )}
            <label className="field">
              每天最多发多少封（留空＝按账号年龄自动放开）
              <input
                type="number"
                min="1"
                max="200"
                step="1"
                placeholder="自动：20 → 30 → 50 → 100 → 200"
                value={form.dailyCap}
                onChange={(e) => change('dailyCap', e.target.value)}
              />
              <small>
                硬上限 200 封/账号/天，按新加坡时间 0
                点重置。新账号自动爬坡，是为了不在最脆弱的头几天把域名烧掉。
              </small>
            </label>
            <div className="settings-actions">
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const savedId = await save();
                    const check = await api('/accounts/' + savedId + '/verify', {
                      method: 'POST',
                    });
                    setVerified(true);
                    setDomainWarnings(check.warnings || []);
                    notify(
                      check.warnings?.length
                        ? '连接成功，但发件域名的 SPF/DKIM/DMARC 有缺口，见下方提示'
                        : isMarketing
                          ? 'Marketing 连接成功，请确认已选择并保存 Audience'
                          : isMailchimp
                            ? 'Mailchimp 凭证和发件域名认证通过'
                            : 'SMTP 连接和身份验证成功',
                    );
                  })
                }
              >
                {busy ? <SpinnerGap className="spin" /> : <Lightning />}保存并测试连接
              </Button>
              <Button kind="primary" type="submit" disabled={busy}>
                <FloppyDisk />
                保存配置
              </Button>
            </div>
            {verified && (
              <div className="list-selection">
                <CheckCircle weight="fill" />
                <div>
                  <strong>连接成功，发件账号已就绪</strong>
                  <p>连接验证不会发送邮件；可在任务中发送测试邮件确认效果。</p>
                  {!!domainWarnings.length && (
                    <ul className="domain-warnings">
                      {domainWarnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </form>
        </section>
        <aside className="settings-help">
          <div className="help-card">
            <ShieldCheck size={30} />
            <h3>账号保存在这台服务器</h3>
            <p>
              授权码和 API Key
              加密保存在运行平台的电脑上，不会返回浏览器。局域网访问者共用账号和任务。
            </p>
          </div>
          <div className="help-section">
            <h3>开始前，准备这三样</h3>
            {(isMarketing
              ? [
                  [
                    '01',
                    'Mailchimp Marketing 账号',
                    '无需额外开通 Transactional；使用 Marketing 套餐额度。',
                  ],
                  ['02', 'Marketing API Key', '填写 API Key 及其服务器前缀，例如 us21。'],
                  [
                    '03',
                    'Audience 与发件身份',
                    '选择已有受众，并在 Mailchimp 完成发件身份、地址和域名设置。',
                  ],
                ]
              : isMailchimp
                ? [
                    ['01', 'Transactional 服务', '开通 Mailchimp Transactional 并具备可用额度。'],
                    ['02', 'Transactional API Key', '在 Mandrill 后台生成并复制 API Key。'],
                    [
                      '03',
                      '自有发件域名',
                      '完成域名验证、DKIM 和 DMARC 认证，不能直接使用 @gmail.com。',
                    ],
                  ]
                : [
                    ['01', '可用的发件邮箱', '确认邮箱已开通 SMTP 服务。'],
                    ['02', '邮箱授权码', '使用服务商生成的应用专用密码。'],
                    ['03', '服务器与端口', '从邮箱官方设置页获取连接信息。'],
                  ]
            ).map(([n, t, d]) => (
              <div className="help-step" key={n}>
                <span>{n}</span>
                <div>
                  <strong>{t}</strong>
                  <p>{d}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="tip">
            <Flask size={20} />
            <p>请先绑定发件账号，再创建发送任务。</p>
          </div>
        </aside>
      </div>
      {passwordHelp && (
        <Modal
          className="password-help-modal"
          title="如何获取 Gmail 应用密码"
          subtitle="从登录到配置，跟着这 6 步完成。"
          onClose={() => setPasswordHelp(false)}
        >
          <AccountPasswordHelp onClose={() => setPasswordHelp(false)} />
        </Modal>
      )}
    </>
  );
}
class ErrorBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="loading-page">
        <h2>页面遇到了一点问题</h2>
        <p>已保存的批量任务和发送记录仍保留在本机。</p>
        <button className="button" onClick={() => location.reload()}>
          刷新页面
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
