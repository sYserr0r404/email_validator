# MailProbe

MailProbe is a local email-address checker. The primary server is Python; it serves the browser UI and runs verification jobs. The UI uses a small amount of JavaScript for background progress updates.

## Checks

- Email syntax and IDN domain validation
- Common disposable-domain detection
- Common domain typo suggestions
- DNS MX, A/AAAA fallback, SPF, and DMARC lookups
- SMTP recipient checks against MX hosts, ordered by priority (up to three hosts)
- Optional catch-all detection
- Per-address timeouts and per-domain serialization

MailProbe never sends an email or issues SMTP `DATA`. SMTP verification can return `UNKNOWN` when the receiving host blocks or declines probes. `UNKNOWN` does not mean an address is fake. IMAP and POP3 are mailbox access protocols; they require account authentication and cannot verify arbitrary addresses without credentials.

## Run locally

Requirements: Python 3.10 or newer.

```powershell
python -m pip install -r requirements.txt
python server.py
```

Open <http://localhost:3000>. To use another port, set `PORT` before starting the server.

```powershell
$env:PORT = "3001"
python server.py
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the app |
| `PROBE_TIMEOUT_MS` | `20000` | Total SMTP probe deadline per address |
| `PROBE_HELO_HOST` | `mailprobe.local` | Name sent in SMTP EHLO |
| `PROBE_MAIL_FROM` | `verify@mailprobe.local` | Envelope sender used for the check |
| `DNS_NAMESERVERS` | `1.1.1.1,8.8.8.8` when the OS exposes none | Comma-separated DNS resolver IPs |

The server checks outbound port 25 at startup. If it cannot connect, it continues in DNS-only mode and marks mailbox-level checks `UNKNOWN`.

## DNS setup

For a domain to receive email, configure the MX records supplied by its email provider. MailProbe uses published MX records first. If there are no MX records, it follows SMTP's implicit-MX fallback to the domain's A/AAAA address; a web proxy or website address may not accept SMTP. The correct MX values depend on the provider, so get them from that provider before changing DNS.

## API

- `GET /api/status` — SMTP mode and diagnostic message
- `POST /api/jobs` — create a job with `{"emails": ["person@example.com"]}` or a delimited string
- `GET /api/jobs/{jobId}` — status, results, and progress
- `POST /api/jobs/{jobId}/retry-unknown` — retry `UNKNOWN` results

A job accepts up to 50 addresses. Job state is held in memory and is cleared when the server restarts.

## Deployment

The included `render.yaml` deploys the Python server. Many managed hosts block outbound port 25; on those hosts the app still performs DNS checks but cannot confirm mailboxes. For full SMTP checks, use a host that permits outbound port 25.

## Legacy Node server

`server.js` and `probe-server.js` remain as legacy implementations and are not used by the Python app. The supported local entry point is `python server.py` (`npm start` also invokes it if Node/npm are already installed).
