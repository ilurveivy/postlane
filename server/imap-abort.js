// Only IMAP is cancelled. In-flight SMTP must finish and persist its outcome
// before ownership can be released.
export function bindImapAbort(client, signal) {
  const close = () => client.close();
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return () => signal?.removeEventListener('abort', close);
}
