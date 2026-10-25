# 📧 MailProbe - Email Verification

Complete email verification service with SMTP probing, DNS validation, and honest result classification.

![MailProbe Screenshot](screenshot.png)

## What It Does

MailProbe verifies email addresses through a multi-stage pipeline:

1. **Syntax validation** (RFC 5321/5322, IDN support, length limits)
2. **Disposable domain detection** (10k+ known providers)
3. **Typo suggestions** (did you mean gmail.com?)
4. **DNS checks** (MX, A/AAAA, null MX, SPF, DMARC)
5. **Big provider detection** (Gmail, Outlook, Yahoo, etc.)
6. **SMTP mailbox probing** (RCPT TO verification on port 25, when available)
7. **Catch-all detection** (tests random addresses)

Results are classified as **VALID**, **INVALID**, **RISKY**, or **UNKNOWN** with specific reasons.

## Status Classification

| Status | Rules |
|--------|-------|
| **VALID** | Domain and MX are valid, SMTP server accepted the recipient, domain is not catch-all, provider is not a big consumer service |
| **INVALID** | Bad syntax, domain doesn't exist, no MX and no A record, null MX (RFC 7505), disposable domain, or SMTP explicitly rejected (550/551/553, 5.1.1/5.1.2/5.1.3) |
| **RISKY** | Catch-all domain (accepts any address), big provider that doesn't confirm mailboxes (gmail.com, outlook.com, yahoo.com, etc.), or likely typo with suggestion |
| **UNKNOWN** | SMTP couldn't complete due to timeout, connection refused, port 25 blocked, 4xx greylisting, 421 service unavailable, 5.7.x policy blocks, or STARTTLS failure. Reason is specific (e.g., "Connection timeout to mx1.example.com:25") |

**Important:** We never report VALID when SMTP verification didn't run.

## Port 25 Detection & Modes

On startup, MailProbe tests outbound TCP connections to port 25 on two public MX hosts:
- `gmail-smtp-in.l.google.com:25`
- `outlook-com.olc.protection.outlook.com:25`

If both fail (5 second timeout each), the app runs in **DNS-only mode**:
- Syntax, typo, disposable, MX, SPF, and DMARC checks run normally
- Addresses that need SMTP verification are marked **UNKNOWN** with reason: "Outbound port 25 is blocked on this server, so the mailbox could not be verified."
- The UI shows an amber banner explaining the limitation

If port 25 is accessible, **full SMTP verification** runs with mailbox-level checks.

### Test Port 25 Yourself

```bash
nc -vz -w 5 gmail-smtp-in.l.google.com 25
```

If this times out or is refused, port 25 is blocked.

## Local Setup

### Prerequisites
- Node.js 20+
- npm

### Installation

```bash
# Install dependencies
npm install

# Set environment variables (optional)
export PROBE_HELO_HOST=mailprobe.yourdomain.com
export PROBE_MAIL_FROM=verify@yourdomain.com
export SMTP_TIMEOUT_MS=8000
export PORT=3000

# Start the server
npm start
```

Visit `http://localhost:3000`

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `PROBE_HELO_HOST` | Domain for EHLO command | `mailprobe.local` |
| `PROBE_MAIL_FROM` | Sender address for MAIL FROM | `verify@mailprobe.local` |
| `SMTP_TIMEOUT_MS` | SMTP operation timeout | `8000` |

## Deployment

### GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mailprobe.git
git push -u origin main
```

### Render (Web Service)

**Note:** Render blocks outbound port 25, so the app runs in DNS-only mode there.

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. New + → Web Service
3. Connect your GitHub repository
4. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Add environment variables (optional):
   - `PROBE_HELO_HOST`: your domain
   - `PROBE_MAIL_FROM`: your email
6. Create Web Service

### VPS (Ubuntu) with Full SMTP

For **full verification**, deploy on a VPS where port 25 is unblocked:

```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and install
git clone https://github.com/YOUR_USERNAME/mailprobe.git
cd mailprobe
npm install

# Set environment variables
export PROBE_HELO_HOST=mail.yourdomain.com
export PROBE_MAIL_FROM=verify@yourdomain.com
export PORT=3000

# Install PM2 for process management
sudo npm install -g pm2

# Start with PM2
pm2 start server.js --name mailprobe
pm2 save
pm2 startup
```

**Important:** Most VPS providers (AWS, Google Cloud, DigitalOcean, Linode) block port 25 by default to prevent spam. You must request they unblock it by opening a support ticket. Some providers (AWS EC2) require you to fill out a "Request to Remove Email Sending Limitations" form.

### Test Port 25 on Your Server

```bash
nc -vz -w 5 gmail-smtp-in.l.google.com 25
telnet gmail-smtp-in.l.google.com 25
```

## Deployment Limits

**Free hosting platforms block port 25:**
- Render ❌
- Railway ❌
- Heroku ❌
- Vercel ❌
- Netlify ❌

Result: DNS-only mode. Addresses needing SMTP are marked UNKNOWN.

**VPS with port 25 unblocking:**
- DigitalOcean ✓ (request unblock)
- Linode ✓ (request unblock)
- Vultr ✓ (request unblock)
- AWS EC2 ✓ (fill out form)
- Google Cloud ✓ (request unblock)

Result: Full SMTP verification.

## API

### GET /api/status

Returns current verification mode.

**Response:**
```json
{
  "mode": "full" | "dns-only",
  "smtpAvailable": true | false,
  "message": "Full SMTP verification active",
  "checkedAt": "2024-10-25T12:00:00.000Z"
}
```

### POST /api/check

Verify email addresses.

**Request:**
```json
{
  "emails": [
    "user@example.com",
    "test@domain.org"
  ]
}
```

Or send a string with newlines/commas/semicolons:
```json
{
  "emails": "user@example.com\ntest@domain.org"
}
```

**Limits:**
- Maximum 50 addresses per request
- Rate limit: 10 requests per minute per IP
- 15 second timeout per address
- Concurrency: 5 addresses at a time
- One SMTP probe per domain at a time

**Response:**
```json
{
  "mode": "full",
  "results": [
    {
      "email": "user@example.com",
      "status": "VALID",
      "reason": "Mailbox verified",
      "mx": "mail.example.com",
      "smtpCode": 250,
      "enhancedCode": "2.1.5",
      "tls": true,
      "catchAll": false,
      "disposable": false,
      "role": false,
      "typoSuggestion": null,
      "spf": true,
      "dmarc": true
    }
  ]
}
```

## No-Sending Guarantee

**MailProbe never sends DATA.** The SMTP probe stops after RCPT TO and immediately sends RSET then QUIT.

This is enforced in code:
- `lib/smtp.js` has an `ALLOWED_COMMANDS` list: `['EHLO', 'STARTTLS', 'MAIL', 'RCPT', 'RSET', 'QUIT']`
- `sendCommand()` throws an error if any other command is attempted
- Tests verify DATA is never sent

## Why UNKNOWN is Valid

UNKNOWN results are **expected** and **normal**:

1. **Port 25 blocked:** Most cloud hosts block it to prevent spam
2. **Greylisting:** Servers delay first-time senders with 4xx codes (450, 451)
3. **Policy blocks:** 5.7.x codes mean "we don't verify for strangers"
4. **Timeouts:** Servers may be slow or rate-limit probes
5. **Connection refused:** Servers may block datacenter IPs

**UNKNOWN does not mean invalid.** It means verification couldn't complete. The address may be perfectly good.

## Tests

Run tests with:

```bash
npm test
```

Tests cover:
- Syntax validation (RFC compliance, IDN, length limits)
- Status classification from SMTP codes and enhanced codes
- Catch-all detection logic
- Port 25 blocking simulation (ETIMEDOUT, ECONNREFUSED)
- Command guard (DATA is forbidden)
- Fake SMTP server scenarios (accepted, rejected 550, greylisted 450, timeout, catch-all)

**No real mail servers are contacted in tests.** Only addresses I own or `example.invalid` are used.

## Credits

Email verification logic adapted from [deep-email-validator](https://github.com/mfbx9da4/deep-email-validator) v0.1.23 (MIT License, David Alberto Adler).

Regex patterns, typo checking (mailcheck), disposable domains (disposable-email-domains), and MX fallback logic are based on that library.

## License

MIT
