import { csv } from './domain.js';
export function campaignExportCsv(c) {
  const labels = {
    pending: '待发送',
    sending: '提交中',
    sent: '发送服务已接受',
    simulated: '演练完成',
    failed: '失败',
    uncertain: '状态待核对',
    cancelled: '已取消',
  };

  return csv([
    [
      '邮箱',
      '模式',
      '状态',
      '时间',
      '原因',
      'Message ID',
      '服务商状态',
      '投递反馈',
      '最近回复',
      '已发送箱核对',
    ],
    ...c.recipients.map((r) => [
      r.email,
      c.mode === 'live' ? '真实发送' : '演练',
      labels[r.status],
      r.sentAt,
      r.error,
      r.messageId,
      r.providerStatus || '',
      r.deliveryStatus === 'bounced' ? '已退信' : '未收到退信不代表送达',
      r.lastReplyAt || '',
      r.sentEvidence ? `${r.sentEvidence.confidence}: ${r.sentEvidence.checkedAt}` : '',
    ]),
  ]);
}
