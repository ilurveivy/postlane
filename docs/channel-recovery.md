# Channel metadata recovery

Imports retain all source columns. Channel ID, name and URL have shared English/Chinese aliases; a valid YouTube channel ID supplies a missing URL. Split tasks retain source list/recipient IDs and full row fields. Follow-up exports require a unique message-ID association and check the source recipient's email before using its metadata.

To repair historical records, extract verified original spreadsheets into a JSON array:

```json
[
  {
    "file": "original.xlsx",
    "sheet": "Sheet1",
    "row": 2,
    "fields": {
      "business_email": "creator@example.com",
      "email_subject": "Exact subject",
      "email_content": "Exact body",
      "channel_id": "UCtYe2zSP5vEnwHFhR3ZDsIA",
      "channel_name": "Channel"
    }
  }
]
```

Run a dry-run first, then apply while no campaigns are running or scheduled:

```bash
node scripts/recover-channel-metadata.mjs data/postlane.sqlite sources.json
node scripts/recover-channel-metadata.mjs data/postlane.sqlite sources.json --apply
```

The tool matches outgoing email (case-insensitive), exact subject and exact body. It skips ambiguous sources, conflicting metadata and any update that would alter rendered historical mail. It fills missing channel fields in existing lists/campaigns, records file/sheet/row provenance, and creates a SQLite backup before an atomic update. It creates no batches or sends. Repeating it makes no further changes.

After repair, compare exports and queue counts with the backup. Source files lacking both a channel URL and valid ID still need operator correction; channel names alone are not used to guess a URL.
