// Keep source columns intact; provide one consistent view for imports and exports.
export function channelMetadata(fields = {}) {
  const read = (...keys) => keys.map((k) => String(fields[k] ?? '').trim()).find(Boolean) || '';
  const channel_id = read('channel_id', '频道ID', '频道id', 'Channel ID');
  return {
    channel_id,
    channel_name: read('channel_name', '频道名称', 'Channel Name'),
    channel_url:
      read('channel_url', '频道链接', 'Channel URL') ||
      (/^UC[\w-]{22}$/.test(channel_id) ? `https://www.youtube.com/channel/${channel_id}` : ''),
  };
}

export function withChannelMetadata(fields) {
  const canonical = Object.fromEntries(
    Object.entries(channelMetadata(fields)).filter(([, v]) => v),
  );
  return { ...fields, ...canonical };
}
