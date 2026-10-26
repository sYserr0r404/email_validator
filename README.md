# MailProbe

MailProbe is a Node.js email-checking web app. It checks email syntax, common typos and disposable domains, DNS/MX, SPF, and DMARC. It can also check mailbox deliverability through the Emailable API when configured.

## Run locally

Requirements: Node.js 20 or newer.

```powershell
npm install
npm start
```

Open <http://localhost:3000>. To use another port:

```powershell
$env:PORT = "3001"
npm start
```

## Add mailbox verification on Render

Render blocks outbound SMTP port 25. Without an external verification provider, the app can check DNS and address format but must report mailbox existence as `UNKNOWN`.

Emailable offers 250 free credits for a new account. A live API request uses one credit per email; a test key returns simulated results and does not perform real mailbox checks. See [Emailable's API docs](https://emailable.com/docs/api/emails/) and [free-account guide](https://emailable.com/docs/getting-started/create-an-account/).

1. Create an Emailable account and confirm your account email. This does not send an OTP to the addresses being checked.
2. In the Emailable dashboard, create a **Live Private API key**. Keep it secret; test keys simulate results.
3. Push this project's latest code to the repository connected to Render and wait for the deploy to finish.
4. In Render, open the service, choose **Environment**, and add `EMAILABLE_API_KEY` with your live private key as its value.
5. Save the environment change and wait for Render to restart the service.
6. Refresh the site. Its status banner should say that Emailable verification is configured. Run a check to use the provider's SMTP verification over HTTPS.

The API key is read only by the Node server and is never sent to the browser. Email addresses submitted for API verification are sent to Emailable over HTTPS. Do not put the key in `public/index.html`, commit it to Git, or paste it into chat.

If `EMAILABLE_API_KEY` is absent, MailProbe uses its existing local DNS/SMTP checks. If Emailable returns an unknown or risky result, MailProbe preserves that result instead of guessing that the mailbox is valid or fake. Catch-all mail domains may not allow any provider to confirm individual mailboxes.

## API

- `GET /api/status` — current verification mode
- `POST /api/jobs` — create a job with `{"emails": ["person@example.com"]}` or a delimited string
- `GET /api/jobs/{jobId}` — status, results, and progress
- `POST /api/jobs/{jobId}/retry-unknown` — retry `UNKNOWN` results

A job accepts up to 50 addresses. Job state is kept in memory and cleared when the server restarts.
