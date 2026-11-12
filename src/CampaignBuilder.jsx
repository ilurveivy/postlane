import { clientId } from './client-id.js';
import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ArrowLeft,
  ArrowRight,
  UploadSimple,
  Eye,
  FloppyDisk,
  PaperPlaneTilt,
} from '@phosphor-icons/react';
import './campaign-builder.css';

const detect = (columns) => ({
  emailColumn:
    columns.find((c) => /^(business_email|email|邮箱|邮箱地址|邮件地址)$/i.test(c)) || '',
  subjectColumn:
    columns.find((c) => /^(email_subject|postlane_subject|subject|邮件标题|标题)$/i.test(c)) || '',
  bodyColumn:
    columns.find((c) =>
      /^(email_content|postlane_body|body|content|邮件话术|邮件正文|正文)$/i.test(c),
    ) || '',
});
const WEEKDAYS = [
  [1, '周一'],
  [2, '周二'],
  [3, '周三'],
  [4, '周四'],
  [5, '周五'],
  [6, '周六'],
  [7, '周日'],
];
const toggle = (items, value) =>
  items.includes(value) ? items.filter((x) => x !== value) : [...items, value];

export default function CampaignBuilder({ api, onCreated, onLegacy }) {
  const [sources, setSources] = useState(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [step, setStep] = useState(0),
    [name, setName] = useState(''),
    [accountIds, setAccountIds] = useState([]),
    [listIds, setListIds] = useState([]);
  const [sourceType, setSourceType] = useState('pending'),
    [fileData, setFileData] = useState(null),
    [sheetIndex, setSheetIndex] = useState(0),
    [mapping, setMapping] = useState({}),
    [limit, setLimit] = useState('');
  const [archiveTo, setArchiveTo] = useState([]),
    [mode] = useState('live'),
    [scheduled, setScheduled] = useState(false),
    [scheduledAt, setScheduledAt] = useState(''),
    [randomInterval, setRandomInterval] = useState(true),
    [rate, setRate] = useState(1);
  const [sendWindow, setSendWindow] = useState({
    enabled: true,
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '18:00',
  });
  const [unsubscribe, setUnsubscribe] = useState(false);
  // 跟进列默认「自动识别」，两个间隔默认 5 天 / 再 10 天，和服务端的默认值一致。
  const [followUpColumns, setFollowUpColumns] = useState({ second: '', third: '' });
  const [followUpDelays, setFollowUpDelays] = useState({ second: '5', third: '10' });
  const [preview, setPreview] = useState(null),
    [sampleIndex, setSampleIndex] = useState(0),
    [sampleEnd, setSampleEnd] = useState('first'),
    [confirm, setConfirm] = useState(false),
    [requestId] = useState(() => clientId());
  const [accountQuery, setAccountQuery] = useState('');
  const fileInput = useRef(null);
  async function loadSources() {
    setLoading(true);
    try {
      setSources(await api('/campaign-builder/sources'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadSources();
  }, []);
  const sheet = fileData?.sheets[sheetIndex];
  const [nameEdited, setNameEdited] = useState(false);
  const [nameStamp] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    return ['month', 'day', 'hour', 'minute']
      .map((k) => parts.find((p) => p.type === k).value)
      .join('');
  });
  const sourceNames =
    sourceType === 'file'
      ? [fileData?.name].filter(Boolean)
      : [
          ...new Set(
            (sources?.lists || [])
              .filter((l) => listIds.includes(l.id))
              .map((l) => l.importTaskName || l.name),
          ),
        ];
  const autoName = sourceNames.length ? `${sourceNames.join('、').slice(0, 90)}-${nameStamp}` : '';
  useEffect(() => {
    if (!nameEdited) setName(autoName);
  }, [autoName, nameEdited]);
  const input = {
    name,
    accountIds,
    listIds: sourceType === 'pending' ? listIds : [],
    ...(sourceType === 'file' && sheet
      ? {
          imported: {
            name: fileData.name,
            sourceFileName: fileData.sourceFileName,
            sheetName: sheet.name,
            rows: sheet.rows,
            ...mapping,
            // 留空表示自动识别；选了就以所选列为准（顺序固定为第二封、第三封）。
            ...(followUpColumns.second || followUpColumns.third
              ? { followUpColumns: [followUpColumns.second, followUpColumns.third] }
              : {}),
          },
        }
      : {}),
    followUpDelays: [followUpDelays.second, followUpDelays.third].map((value, index) => {
      const days = Number(value);
      return Number.isInteger(days) && days >= 1 ? Math.min(days, 90) : index === 0 ? 5 : 10;
    }),
    ...(limit ? { limit: Number(limit) } : {}),
    archiveTo,
    mode,
    scheduledAt: scheduled ? (scheduledAt ? new Date(scheduledAt).toISOString() : '') : null,
    randomInterval,
    rate,
    sendWindow,
    unsubscribe,
  };
  // The reviewed payload is immutable until the next preview; every option change invalidates it.
  const signature = JSON.stringify(input);
  useEffect(() => {
    setPreview(null);
    setConfirm(false);
  }, [signature]);
  const matching = (sources?.accounts || []).filter((a) =>
    (a.email + ' ' + a.name).toLowerCase().includes(accountQuery.toLowerCase()),
  );
  const selectedCount =
    sourceType === 'pending'
      ? (sources?.lists || [])
          .filter((l) => listIds.includes(l.id))
          .reduce((n, l) => n + l.count, 0)
      : sheet?.rows.length || 0;
  async function work(fn) {
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
  function chooseSheet(i, data = fileData) {
    setSheetIndex(i);
    setMapping(detect(data.sheets[i].columns));
    setFollowUpColumns({ second: '', third: '' });
    setLimit('');
  }
  function upload(file) {
    if (!file) return;
    work(async () => {
      if (!/\.(xlsx|csv)$/i.test(file.name)) throw Error('请选择 .xlsx 或 UTF-8 .csv 文件');
      if (file.size > 5 * 1024 * 1024) throw Error('文件不能超过 5 MB');
      const fd = new FormData();
      fd.append('file', file);
      const data = await api('/import', { method: 'POST', body: fd });
      data.name = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
      setFileData(data);
      chooseSheet(0, data);
    });
  }
  async function review() {
    if (!accountIds.length) throw Error('请至少选择一个可用发件账号');
    if (sourceType === 'pending' && !listIds.length) throw Error('请选择未排期批次');
    if (
      sourceType === 'file' &&
      (!sheet || !mapping.emailColumn || !mapping.subjectColumn || !mapping.bodyColumn)
    )
      throw Error('请导入表格并确认邮箱、标题和正文列');
    if (scheduled && (!scheduledAt || Date.parse(scheduledAt) <= Date.now()))
      throw Error('请选择未来的预约时间');
    const p = await api('/campaign-builder/preview', { method: 'POST', body: input });
    setPreview({ ...p, input: JSON.parse(signature) });
    setSampleIndex(0);
    setConfirm(false);
    return p;
  }
  async function submit(action) {
    if (!preview) throw Error('请先重新核对分配结果');
    const result = await api('/campaign-builder', {
      method: 'POST',
      body: {
        ...preview.input,
        requestId,
        fingerprint: preview.fingerprint,
        action,
        confirmLive: confirm,
      },
    });
    await onCreated(result);
  }
  const sample = preview?.samples[sampleIndex];
  const recipient = sample?.[sampleEnd];
  return (
    <div className="multi-builder">
      <div className="builder-title">
        <div>
          <span className="eyebrow">NEW CAMPAIGN</span>
          <h1>分配邮件，安排发送。</h1>
          <p>选择账号和邮件来源，系统自动均分。每封邮件保留原始标题与正文。</p>
        </div>
        <button type="button" className="text-button" disabled={busy} onClick={onLegacy}>
          单账号模板 / Mailchimp
        </button>
      </div>
      {error && (
        <div className="builder-error" role="alert">
          {error}
        </div>
      )}
      <div className="builder-grid">
        <section className="panel builder-panel">
          <nav className="stepper" aria-label="创建任务步骤">
            {['账号与邮件', '内容与设置', '核对并提交'].map((s, i) => (
              <button
                type="button"
                key={s}
                disabled={busy || i > step}
                className={i === step ? 'current' : i < step ? 'done' : ''}
                onClick={() => setStep(i)}
              >
                <span>{i < step ? <Check size={14} /> : i + 1}</span>
                {s}
                {i < 2 && <i />}
              </button>
            ))}
          </nav>
          <div className="builder-content">
            {step === 0 && (
              <>
                <label className="field">
                  任务名称
                  <input
                    maxLength={100}
                    value={name}
                    placeholder="选择邮件来源后自动生成"
                    onChange={(e) => {
                      setNameEdited(!!e.target.value);
                      setName(e.target.value);
                    }}
                  />
                </label>
                <div className="builder-section-heading">
                  <h2>
                    发件账号 <small>已选 {accountIds.length} 个</small>
                  </h2>
                  <div>
                    <button
                      type="button"
                      className="text-button"
                      disabled={loading || busy || !sources}
                      onClick={() => setAccountIds(sources.accounts.map((a) => a.id))}
                    >
                      全选可用账号
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => setAccountIds([])}
                    >
                      清空
                    </button>
                  </div>
                </div>
                <input
                  className="builder-search"
                  aria-label="搜索发件账号"
                  placeholder="搜索邮箱或发件人名称"
                  value={accountQuery}
                  onChange={(e) => setAccountQuery(e.target.value)}
                />
                <div className="builder-account-list">
                  {loading ? (
                    <p>正在读取可用账号…</p>
                  ) : matching.length ? (
                    matching.map((a) => (
                      <label
                        key={a.id}
                        className={
                          'builder-choice ' + (accountIds.includes(a.id) ? 'selected' : '')
                        }
                      >
                        <input
                          type="checkbox"
                          checked={accountIds.includes(a.id)}
                          onChange={() => setAccountIds(toggle(accountIds, a.id))}
                        />
                        <span>
                          <strong>{a.email}</strong>
                          <small>{a.name}</small>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p>没有可用账号。请在发件设置中添加账号并测试连接。</p>
                  )}
                </div>
                {!loading && !sources && (
                  <button type="button" className="button" onClick={loadSources}>
                    重新读取
                  </button>
                )}
                <p className="builder-muted">
                  仅显示已验证或有成功发送记录的 SMTP 账号；停用及只做回复用的账号不参与分配。
                </p>
                <div className="builder-section-heading">
                  <h2>邮件来源</h2>
                  <span>按添加时间从早到晚分配</span>
                </div>
                <div className="builder-source-toggle">
                  <button
                    type="button"
                    aria-pressed={sourceType === 'pending'}
                    onClick={() => {
                      setSourceType('pending');
                      setLimit('');
                    }}
                  >
                    选择未排期批次
                  </button>
                  <button
                    type="button"
                    aria-pressed={sourceType === 'file'}
                    onClick={() => {
                      setSourceType('file');
                      setLimit('');
                    }}
                  >
                    导入 Excel / CSV
                  </button>
                </div>
                {sourceType === 'pending' ? (
                  <div className="builder-source-list">
                    {sources?.lists.length
                      ? sources.lists.map((l) => (
                          <label
                            key={l.id}
                            className={
                              'builder-choice ' + (listIds.includes(l.id) ? 'selected' : '')
                            }
                          >
                            <input
                              type="checkbox"
                              checked={listIds.includes(l.id)}
                              onChange={() => setListIds(toggle(listIds, l.id))}
                            />
                            <span>
                              <strong>{l.name}</strong>
                              <small>
                                {new Date(l.createdAt).toLocaleString('zh-CN')} · {l.count} 封未排期
                              </small>
                            </span>
                          </label>
                        ))
                      : !loading && <p>暂无未排期邮件，可以直接导入表格。</p>}
                  </div>
                ) : (
                  <>
                    <input
                      ref={fileInput}
                      hidden
                      type="file"
                      accept=".xlsx,.csv"
                      onChange={(e) => {
                        upload(e.target.files[0]);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      className="builder-upload"
                      disabled={busy}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!busy) upload(e.dataTransfer.files[0]);
                      }}
                      onClick={() => fileInput.current.click()}
                    >
                      <UploadSimple size={25} />
                      <strong>
                        {busy
                          ? '正在解析…'
                          : fileData
                            ? '重新选择表格'
                            : '拖入表格，或点击选择文件'}
                      </strong>
                      <small>自动识别邮箱、标题和正文 · 最大 5 MB</small>
                    </button>
                    {sheet && (
                      <div className="builder-mapping">
                        <label className="field">
                          工作表
                          <select
                            value={sheetIndex}
                            onChange={(e) => chooseSheet(Number(e.target.value))}
                          >
                            {fileData.sheets.map((s, i) => (
                              <option value={i} key={i}>
                                {s.name} · {s.rows.length} 行
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="builder-mapping-fields">
                          {[
                            ['emailColumn', '收件邮箱'],
                            ['subjectColumn', '邮件标题'],
                            ['bodyColumn', '邮件正文'],
                          ].map(([key, label]) => (
                            <label className="field" key={key}>
                              {label}
                              <select
                                value={mapping[key] || ''}
                                onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
                              >
                                <option value="">请选择对应列</option>
                                {sheet.columns.map((c) => (
                                  <option key={c}>{c}</option>
                                ))}
                              </select>
                            </label>
                          ))}
                        </div>
                        <p className="builder-muted">
                          支持 business_email / email_subject /
                          email_content，无法识别的列请手动选择。无效、重复、停发邮箱会在预览中说明。
                        </p>
                        <div className="builder-mapping-fields">
                          <label className="field">
                            第二封跟进（选填）
                            <select
                              value={followUpColumns.second}
                              onChange={(e) =>
                                setFollowUpColumns({ ...followUpColumns, second: e.target.value })
                              }
                            >
                              <option value="">自动识别「第二封跟进」</option>
                              {sheet.columns.map((c) => (
                                <option key={c}>{c}</option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            第三封跟进（选填）
                            <select
                              value={followUpColumns.third}
                              onChange={(e) =>
                                setFollowUpColumns({ ...followUpColumns, third: e.target.value })
                              }
                            >
                              <option value="">自动识别「第三封跟进」</option>
                              {sheet.columns.map((c) => (
                                <option key={c}>{c}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <p className="builder-muted">
                          这两列留空就表示没有后续跟进。单元格开头写一行「主题：…」可以单独指定跟进标题，
                          否则自动回「Re: 原主题」，并挂在同一封邮件的会话里。
                        </p>
                      </div>
                    )}
                  </>
                )}
                <label className="field builder-limit">
                  本次安排数量（选填）
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    placeholder={`默认安排全部（来源共 ${selectedCount} 条）`}
                    value={limit}
                    onChange={(e) => setLimit(e.target.value)}
                  />
                  <small>填写数量后按来源顺序截取，其余邮件保留在未排期中。</small>
                </label>
              </>
            )}
            {step === 1 && (
              <>
                <div className="builder-section-heading">
                  <h2>末封留存副本</h2>
                  <span>默认不发送</span>
                </div>
                <p className="builder-muted">
                  每个账号将最后一封正式邮件的相同标题和正文，分别独立发给所勾选的邮箱。副本不占均分数量。
                </p>
                {(sources?.archiveRecipients || []).map((email) => (
                  <label
                    key={email}
                    className={'builder-choice ' + (archiveTo.includes(email) ? 'selected' : '')}
                  >
                    <input
                      type="checkbox"
                      checked={archiveTo.includes(email)}
                      onChange={() => setArchiveTo(toggle(archiveTo, email))}
                    />
                    <span>
                      <strong>{email}</strong>
                    </span>
                  </label>
                ))}
                <p className="builder-muted">
                  不勾选就不发送留存副本，不影响正式任务的报告邮件。执行报告与 12
                  小时核查报告的收件人由服务端配置（见「批次报表」页）。
                </p>
                <div className="builder-section-heading">
                  <h2>发送设置</h2>
                </div>
                <div className="form-row">
                  <label className="field">
                    发送间隔
                    <select
                      value={randomInterval ? 'random' : 'fixed'}
                      onChange={(e) => setRandomInterval(e.target.value === 'random')}
                    >
                      <option value="random">随机间隔 · 30–120 秒</option>
                      <option value="fixed">固定速度</option>
                    </select>
                  </label>
                  {!randomInterval && (
                    <label className="field">
                      每分钟封数
                      <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                        {[1, 5, 20, 60].map((n) => (
                          <option key={n} value={n}>
                            {n} 封 / 分钟
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <label className="field">
                  发送时间窗口（新加坡时间）
                  <select
                    value={sendWindow.enabled ? 'on' : 'off'}
                    onChange={(e) =>
                      setSendWindow({ ...sendWindow, enabled: e.target.value === 'on' })
                    }
                  >
                    <option value="on">只在指定时段发送</option>
                    <option value="off">不限时段（可能在深夜发出，不推荐）</option>
                  </select>
                  <small>
                    每个发件邮箱每天还有上限：新账号按 20 → 30 → 50 → 100 → 200 逐步放开。
                  </small>
                </label>
                {sendWindow.enabled && (
                  <>
                    <div className="form-row">
                      <label className="field">
                        从
                        <input
                          type="time"
                          value={sendWindow.start}
                          onChange={(e) => setSendWindow({ ...sendWindow, start: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        到
                        <input
                          type="time"
                          value={sendWindow.end}
                          onChange={(e) => setSendWindow({ ...sendWindow, end: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className="field">
                      发送日
                      <div className="weekday-picker">
                        {WEEKDAYS.map(([value, label]) => (
                          <label
                            key={value}
                            className={
                              'weekday' + (sendWindow.days.includes(value) ? ' active' : '')
                            }
                          >
                            <input
                              type="checkbox"
                              checked={sendWindow.days.includes(value)}
                              onChange={() =>
                                setSendWindow({
                                  ...sendWindow,
                                  days: toggle(sendWindow.days, value),
                                })
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <div className="field">
                  多步跟进间隔（天）
                  <div className="form-row">
                    <label className="field">
                      第二封在首封后
                      <input
                        type="number"
                        min={1}
                        max={90}
                        value={followUpDelays.second}
                        onChange={(e) =>
                          setFollowUpDelays({ ...followUpDelays, second: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      第三封在第二封后
                      <input
                        type="number"
                        min={1}
                        max={90}
                        value={followUpDelays.third}
                        onChange={(e) =>
                          setFollowUpDelays({ ...followUpDelays, third: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <small>
                    只对表格里填了「第二封跟进 / 第三封跟进」的人生效。到期前对方回过信就不发，
                    前一封没确认送达也不发；整条序列算在同一个任务的额度里。
                  </small>
                </div>
                <label className="field">
                  退订说明
                  <select
                    value={unsubscribe ? 'on' : 'off'}
                    onChange={(e) => setUnsubscribe(e.target.value === 'on')}
                  >
                    <option value="off">不加（一对一私信风格）</option>
                    <option value="on">在邮件末尾加一行「回复即可退订」</option>
                  </select>
                  <small>
                    加了更容易被识别为营销邮件，但投诉率更低；同时会带 List-Unsubscribe 头。
                  </small>
                </label>
                <label className="field">
                  开始时间
                  <select
                    value={scheduled ? 'later' : 'now'}
                    onChange={(e) => setScheduled(e.target.value === 'later')}
                  >
                    <option value="now">确认后立即开始</option>
                    <option value="later">预约发送</option>
                  </select>
                </label>
                {scheduled && (
                  <label className="field">
                    预约时间（本机时区）
                    <input
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                    />
                    <small>需要保持电脑唤醒并运行平台。</small>
                  </label>
                )}
              </>
            )}
            {step === 2 && preview && (
              <>
                <div className="builder-section-heading">
                  <h2>检查分配结果</h2>
                  <span>{preview.input.mode === 'live' ? '真实发送' : '仅演练'}</span>
                </div>
                <div className="builder-totals">
                  <div>
                    <strong>{preview.formal}</strong>
                    <span>正式邮件</span>
                  </div>
                  <div>
                    <strong>{preview.copies}</strong>
                    <span>留存副本</span>
                  </div>
                  <div>
                    <strong>{preview.total}</strong>
                    <span>总邮件数</span>
                  </div>
                </div>
                <p className="builder-muted">
                  开始时间：
                  {preview.input.scheduledAt
                    ? new Date(preview.input.scheduledAt).toLocaleString('zh-CN')
                    : '确认后立即开始'}
                  。均分后每账号正式邮件数最多相差 1 封；未分配邮件的账号不会创建任务或发送副本。
                </p>
                <p className="builder-muted">
                  {preview.sendWindow?.enabled
                    ? '发送窗口：新加坡时间 ' +
                      preview.sendWindow.start +
                      '–' +
                      preview.sendWindow.end +
                      '，' +
                      preview.sendWindow.days
                        .map((d) => WEEKDAYS.find(([v]) => v === d)?.[1] || '')
                        .filter(Boolean)
                        .join('、') +
                      '；窗口外自动挂起，不会深夜发出。'
                    : '发送窗口：不限时段。'}
                  {preview.unsubscribe ? ' 邮件末尾会附加退订说明。' : ' 不附加退订说明。'}
                </p>
                {!!(preview.followUps?.second || preview.followUps?.third) && (
                  <p className="builder-muted">
                    多步跟进：第二封 {preview.followUps.second} 人（首封后{' '}
                    {preview.followUps.delays[0]} 天）、第三封 {preview.followUps.third}{' '}
                    人（第二封后 {preview.followUps.delays[1] || 10} 天）。对方回信即停。
                  </p>
                )}
                {preview.unsubscribe && preview.unsubscribeLinkAvailable === false && (
                  <p className="builder-muted">
                    未配置
                    POSTLANE_PUBLIC_ORIGIN：邮件里不带一键退订链接，退订由正文的「回复退订」生效 ——
                    这是默认的轻量方案，够用。想要 Gmail 的一键退订按钮，再配一个外网 HTTPS 地址
                    （见 docs/unsubscribe.md）。
                  </p>
                )}
                {!!preview.limits?.length && (
                  <p className="builder-muted">
                    今日剩余额度：
                    {preview.limits
                      .map(
                        (l) =>
                          l.email + ' ' + Math.max(0, l.dailyCap - l.sentToday) + '/' + l.dailyCap,
                      )
                      .join(' · ')}
                    （按新加坡时间 0 点重置；超出部分自动排到下一个发送窗口）
                  </p>
                )}
                {preview.uniqueEmails < preview.formal && (
                  <div className="builder-error">
                    这批文案涉及 {preview.uniqueEmails}{' '}
                    个不同邮箱，部分邮箱会收到多封不同内容，请核对。
                  </div>
                )}
                {!!preview.addressWarnings?.length && (
                  <details className="builder-issues">
                    <summary>
                      存在风险 {preview.addressWarnings.length} 个邮箱（保留，需核查）
                    </summary>
                    {preview.addressWarnings.map((r) => (
                      <p key={r.email}>
                        {r.email}：{r.reason}
                      </p>
                    ))}
                    <p>仅检查域名和历史记录，不能保证具体邮箱存在或邮件送达。</p>
                  </details>
                )}
                {!!preview.issues.length && (
                  <details className="builder-issues">
                    <summary>已排除 {preview.issues.length} 条异常或停发记录</summary>
                    <ul>
                      {preview.issues.slice(0, 50).map((r, i) => (
                        <li key={i}>
                          {r.row ? `第 ${r.row} 行 · ` : ''}
                          {r.email} · {r.reason}
                        </li>
                      ))}
                    </ul>
                    {preview.issues.length > 50 && <p>仅展示前 50 条。</p>}
                  </details>
                )}
                <div className="builder-allocation">
                  <table>
                    <thead>
                      <tr>
                        <th>发件账号</th>
                        <th>正式</th>
                        <th>副本</th>
                        <th>合计</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.groups.map((g) => (
                        <tr key={g.account.id}>
                          <td>{g.account.email}</td>
                          <td>{g.formal}</td>
                          <td>{g.copies}</td>
                          <td>{g.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {mode === 'live' && (
                  <label className="checkbox-label builder-confirm">
                    <input
                      type="checkbox"
                      checked={confirm}
                      onChange={(e) => setConfirm(e.target.checked)}
                    />
                    我已核对账号、邮件内容、分配数量及副本收件人，确认真实发送。
                  </label>
                )}
              </>
            )}
            {step === 2 && !preview && (
              <div className="builder-error">设置已变化，请返回上一步重新核对。</div>
            )}
          </div>
          <div className="compose-footer">
            <button
              type="button"
              className="button"
              disabled={busy || step === 0}
              onClick={() => setStep(step - 1)}
            >
              <ArrowLeft />
              上一步
            </button>
            <div className="builder-footer-actions">
              {step === 2 && (
                <button
                  type="button"
                  className="button"
                  disabled={busy || !preview}
                  onClick={() => work(() => submit('draft'))}
                >
                  <FloppyDisk />
                  保存草稿
                </button>
              )}
              {step < 2 ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || loading}
                  onClick={() =>
                    work(async () => {
                      await review();
                      setStep(step + 1);
                    })
                  }
                >
                  {busy ? '正在核对…' : step === 0 ? '下一步' : '核对分配'}
                  <ArrowRight />
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !preview || (mode === 'live' && !confirm)}
                  onClick={() => work(() => submit('start'))}
                >
                  <PaperPlaneTilt />
                  {busy
                    ? '提交中…'
                    : mode === 'simulation'
                      ? '开始演练'
                      : scheduled
                        ? '确认预约'
                        : '确认发送'}
                </button>
              )}
            </div>
          </div>
        </section>
        <aside className="builder-preview">
          <div className="builder-preview-title">
            <Eye size={19} />
            <span>原文预览</span>
          </div>
          {preview ? (
            <>
              <div className="builder-preview-controls">
                <label className="field">
                  查看发件账号
                  <select
                    value={sampleIndex}
                    onChange={(e) => setSampleIndex(Number(e.target.value))}
                  >
                    {preview.samples.map((s, i) => (
                      <option key={s.account.id} value={i}>
                        {s.account.email}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="builder-source-toggle">
                  <button
                    type="button"
                    aria-pressed={sampleEnd === 'first'}
                    onClick={() => setSampleEnd('first')}
                  >
                    首封邮件
                  </button>
                  <button
                    type="button"
                    aria-pressed={sampleEnd === 'last'}
                    onClick={() => setSampleEnd('last')}
                  >
                    末封 / 副本内容
                  </button>
                </div>
              </div>
              <article className="panel builder-mail">
                <header>
                  <strong>{recipient?.fields.email_subject}</strong>
                  <p>发件：{sample?.account.email}</p>
                  <p>收件：{recipient?.email}</p>
                </header>
                <div>{recipient?.fields.email_content}</div>
              </article>
              {sampleEnd === 'last' && (
                <p className="builder-muted">
                  副本收件人：{preview.input.archiveTo.join('、') || '未勾选，不发送副本'}。
                </p>
              )}
            </>
          ) : (
            <div className="panel builder-preview-empty">
              <EnvelopePreview />
              <h3>先选账号与邮件</h3>
              <p>点击下一步，查看各账号的首封和末封邮件。原始标题与正文不会被改写。</p>
            </div>
          )}
          <p className="builder-muted">
            邮箱 → business_email
            <br />
            标题 → email_subject
            <br />
            正文 → email_content
            <br />
            自定义列会按你选择的映射读取。
          </p>
        </aside>
      </div>
    </div>
  );
}
function EnvelopePreview() {
  return <PaperPlaneTilt size={34} weight="light" />;
}
