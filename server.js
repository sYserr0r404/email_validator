import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { validateSyntax, isRoleAccount } from './lib/syntax.js';
import { checkDNS } from './lib/dns.js';
import { checkTypo } from './lib/typo.js';
import { isDisposable } from './lib/disposable.js';
import { probeMailboxResilient } from './lib/smtp.js';
import { classify } from './lib/classify.js';
import { checkPort25 } from './lib/portcheck.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PROBE_TIMEOUT = parseInt(process.env.PROBE_TIMEOUT_MS || '20000');
const JOB_MAX_MS = parseInt(process.env.JOB_MAX_MS || '600000');
const DOMAIN_GAP = 2000;
const EMAILABLE_API_KEY = process.env.EMAILABLE_API_KEY?.trim();

// Job store
const jobs = new Map();
const domainQueues = new Map();

let smtpMode = 'checking';
let port25Status = null;

// Trust proxy - required for Render, Vercel, Railway, etc.
app.set('trust proxy', 1);

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', limiter);

// Check port 25 on startup (non-blocking with timeout)
let checkStarted = false;
(async () => {
  if (checkStarted) return;
  checkStarted = true;

  if (EMAILABLE_API_KEY) {
    smtpMode = 'api';
    port25Status = {
      available: true,
      message: 'Emailable verification API configured. Mailbox checks use HTTPS through the provider.',
      testedAt: new Date().toISOString()
    };
    console.log(`📧 Mode: API (Emailable)`);
    return;
  }
  
  console.log('🔍 Checking outbound port 25 availability...');
  try {
    // Add 5-second timeout to prevent hanging on Render
    const timeoutPromise = new Promise((resolve) => 
      setTimeout(() => resolve({ available: false, message: 'Port check timeout', testedAt: new Date() }), 5000)
    );
    port25Status = await Promise.race([checkPort25(), timeoutPromise]);
  } catch (err) {
    port25Status = { available: false, message: 'Port check failed', testedAt: new Date() };
  }
  
  smtpMode = port25Status.available ? 'full' : 'dns-only';
  console.log(`📧 Mode: ${smtpMode.toUpperCase()}`);
  console.log(`   ${port25Status.message}`);
})();

// Clean up stuck jobs on startup
for (const [jobId, job] of jobs.entries()) {
  jobs.delete(jobId);
}

// Job watchdog
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (job.status !== 'done' && (now - job.createdAt) > JOB_MAX_MS) {
      job.status = 'done';
      for (const [email, result] of job.results.entries()) {
        if (result.status === 'QUEUED' || result.status === 'CHECKING') {
          result.status = 'UNKNOWN';
          result.reason = 'Job timed out. Retry.';
        }
      }
    }
  }
}, 30000);

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    mode: smtpMode,
    smtpAvailable: smtpMode === 'full' || smtpMode === 'api',
    message: port25Status?.message || 'Checking...',
    checkedAt: port25Status?.testedAt || null
  });
});

// POST /api/jobs
app.post('/api/jobs', (req, res) => {
  try {
    let { emails } = req.body;

    if (typeof emails === 'string') {
      emails = emails
        .split(/[\n,;]+/)
        .flatMap(e => e.split(/\s+/))
        .map(e => e.trim())
        .filter(e => e.length > 0);
    }

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'No emails provided' });
    }

    emails = [...new Set(emails)];
    if (emails.length > 50) {
      return res.status(400).json({ error: 'Max 50 emails per job' });
    }

    const jobId = randomUUID();
    const emailMap = new Map();
    emails.forEach(email => {
      emailMap.set(email, {
        email,
        status: 'QUEUED',
        reason: 'Waiting to verify...',
        mx: null,
        smtpCode: null,
        enhancedCode: null,
        tls: false,
        catchAll: false,
        disposable: false,
        role: false,
        typoSuggestion: null,
        spf: false,
        dmarc: false
      });
    });

    const job = {
      jobId,
      status: 'queued',
      results: emailMap,
      queue: [...emails],
      domainQueues: new Map(),
      startedAt: null,
      createdAt: Date.now(),
      mode: smtpMode
    };

    jobs.set(jobId, job);
    processJob(jobId).catch(err => console.error(`Job ${jobId} error:`, err));

    res.json({ jobId });
  } catch (error) {
    console.error('Job creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/jobs/:id
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const results = Array.from(job.results.values());
  const pending = results.filter(r => r.status === 'QUEUED' || r.status === 'CHECKING').length;

  res.json({
    jobId: job.jobId,
    status: job.status,
    results,
    pending,
    progress: { total: results.length, completed: results.length - pending },
    startedAt: job.startedAt,
    createdAt: job.createdAt
  });
});

// POST /api/jobs/:id/retry-unknown
app.post('/api/jobs/:id/retry-unknown', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const unknowns = Array.from(job.results.values())
    .filter(r => r.status === 'UNKNOWN')
    .map(r => r.email);

  if (unknowns.length === 0) {
    return res.json({ message: 'No UNKNOWN results', count: 0 });
  }

  unknowns.forEach(email => {
    job.queue.push(email);
    job.results.get(email).status = 'QUEUED';
    job.results.get(email).reason = 'Retrying...';
  });

  job.status = 'queued';
  processJob(req.params.id).catch(err => console.error(`Retry error:`, err));

  res.json({ message: 'Retrying UNKNOWN', count: unknowns.length });
});

// GET /api/debug
app.get('/api/debug', (req, res) => {
  const queues = {};
  for (const [domain, queue] of domainQueues.entries()) {
    queues[domain] = queue._pending || 0;
  }

  res.json({
    activeJobs: jobs.size,
    activeDomains: domainQueues.size,
    domainQueues: queues,
    smtpMode
  });
});

/**
 * Process job queue with per-domain sequential processing
 */
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  if (!job.startedAt) {
    job.startedAt = Date.now();
  }

  if (job.status === 'queued') {
    job.status = 'running';
  }

  try {
    // Group emails by domain
    const emailsByDomain = new Map();
    for (const email of job.queue) {
      const domain = email.split('@')[1];
      if (!emailsByDomain.has(domain)) {
        emailsByDomain.set(domain, []);
      }
      emailsByDomain.get(domain).push(email);
    }

    // Process each domain sequentially
    for (const [domain, emails] of emailsByDomain.entries()) {
      for (const email of emails) {
        const result = job.results.get(email);
        if (!result) continue;

        result.status = 'CHECKING';
        try {
          const verified = await probeEmailWithTimeout(email, job.mode, PROBE_TIMEOUT);
          Object.assign(result, verified);
        } catch (err) {
          result.status = 'UNKNOWN';
          result.reason = 'Verification error';
          console.error(`Error checking ${email}:`, err.message);
        }

        // Gap between emails in same domain
        await new Promise(resolve => setTimeout(resolve, DOMAIN_GAP));
      }
    }

    // Clear queue
    job.queue.length = 0;
  } catch (err) {
    console.error(`Job ${jobId} processing error:`, err);
  } finally {
    job.status = 'done';
    job.domainQueues.clear();
  }
}

/**
 * Probe email with hard timeout
 */
async function probeEmailWithTimeout(email, mode, timeoutMs) {
  let timeoutHandle;
  let stage = 'DNS lookup';
  try {
    return await Promise.race([
      probeEmail(email, mode, timeoutMs, value => { stage = value; }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Verification timed out')), timeoutMs);
      })
    ]);
  } catch (err) {
    return {
      email,
      status: 'UNKNOWN',
      reason: stage.startsWith('SMTP')
        ? `${stage} did not respond. The mailbox could not be confirmed; check the domain's MX records and email provider.`
        : 'Domain DNS lookup did not respond. The mailbox could not be confirmed; you can retry.',
      mx: null,
      smtpCode: null,
      enhancedCode: null,
      tls: false,
      catchAll: false,
      disposable: false,
      role: false,
      typoSuggestion: null,
      spf: false,
      dmarc: false
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function probeEmail(email, mode, timeoutMs, setStage = () => {}) {
  const result = {
    email,
    status: 'UNKNOWN',
    reason: '',
    mx: null,
    smtpCode: null,
    enhancedCode: null,
    tls: false,
    catchAll: false,
    disposable: false,
    role: false,
    typoSuggestion: null,
    spf: false,
    dmarc: false
  };

  try {
    const syntax = validateSyntax(email);
    if (!syntax.valid) {
      const { status, reason } = classify({ syntax, smtpMode: mode });
      result.status = status;
      result.reason = reason;
      return result;
    }

    const { local, domain } = syntax;
    result.role = isRoleAccount(local);

    result.disposable = isDisposable(domain);
    if (result.disposable) {
      const { status, reason } = classify({ syntax, disposable: true, smtpMode: mode });
      result.status = status;
      result.reason = reason;
      return result;
    }

    const typo = await checkTypo(email);
    result.typoSuggestion = typo.suggestion;
    if (typo.suggestion) {
      const { status, reason } = classify({ 
        syntax, 
        disposable: false, 
        typoSuggestion: typo.suggestion,
        smtpMode: mode 
      });
      result.status = status;
      result.reason = reason;
      return result;
    }

    if (EMAILABLE_API_KEY) {
      setStage('Emailable verification API');
      const apiResult = await verifyWithEmailable(email, timeoutMs);
      Object.assign(result, apiResult, { email });
      return result;
    }

    setStage('DNS lookup');
    const dns = await checkDNS(domain);
    result.spf = !!dns.spf;
    result.dmarc = !!dns.dmarc;

    if (dns.error || dns.mx.length === 0) {
      const { status, reason } = classify({ 
        syntax, 
        disposable: false, 
        typoSuggestion: null,
        dns,
        smtpMode: mode 
      });
      result.status = status;
      result.reason = reason;
      return result;
    }

    result.mx = dns.mx[0].exchange;

    const bigProviders = [
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
      'live.com', 'yahoo.com', 'icloud.com', 'protonmail.com'
    ];

    if (bigProviders.includes(domain)) {
      const { status, reason } = classify({ 
        syntax, 
        disposable: false, 
        typoSuggestion: null,
        dns,
        domain,
        smtpMode: mode 
      });
      result.status = status;
      result.reason = reason;
      return result;
    }

    let smtp = null;
    if (mode === 'full') {
      setStage(`SMTP check at ${dns.mx[0].exchange}${dns.mxRecordFound ? '' : ' (no MX record; using domain A record)'}`);
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
      }, timeoutMs);

      try {
        const sender = process.env.PROBE_MAIL_FROM;
        smtp = await probeMailboxResilient(email, dns.mx, sender, timeoutMs);

        if (timedOut) {
          throw new Error('Server did not respond');
        }

        result.smtpCode = smtp.code;
        result.enhancedCode = smtp.enhancedCode;
        result.tls = smtp.tls;
        result.catchAll = smtp.catchAll;
        result._smtpDetails = {
          mxHost: smtp.mxHost,
          attempts: smtp.attempts?.length || 0,
          rawReplies: smtp.rawReplies || []
        };
      } catch (err) {
        if (timedOut) {
          smtp = { error: 'Server did not respond', accepted: false };
        } else {
          smtp = { error: err.message, accepted: false };
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    const { status, reason } = classify({ 
      syntax, 
      disposable: false, 
      typoSuggestion: null,
      dns,
      smtp,
      domain,
      smtpMode: mode 
    });

    result.status = status;
    result.reason = reason;

  } catch (error) {
    console.error(`Error checking ${email}:`, error);
    result.status = 'UNKNOWN';
    result.reason = 'Verification error';
  }

  return result;
}

/** Verify a mailbox through Emailable's API so the Render app does not need
 * direct outbound SMTP access. The private API key stays server-side. */
async function verifyWithEmailable(email, timeoutMs) {
  const url = new URL('https://api.emailable.com/v1/verify');
  url.searchParams.set('email', email);
  url.searchParams.set('smtp', 'true');
  // Emailable documents a 2-10 second range for its single-email timeout.
  url.searchParams.set('timeout', String(Math.min(10, Math.max(2, Math.floor(timeoutMs / 1000)))));

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${EMAILABLE_API_KEY}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'Emailable verification timed out. You can retry.'
      : 'Could not reach the Emailable verification service. You can retry.';
    return { status: 'UNKNOWN', reason };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { status: 'UNKNOWN', reason: 'Emailable returned an unreadable response. You can retry.' };
  }

  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403
      ? 'Emailable rejected the API key. Check the server-side API key in Render.'
      : response.status === 402
        ? 'Emailable has no available verification credits.'
        : response.status === 249 || response.status === 408 || response.status === 504
          ? 'Emailable verification timed out. You can retry.'
          : `Emailable verification failed (HTTP ${response.status}). You can retry.`;
    return { status: 'UNKNOWN', reason };
  }

  const state = String(data.state || '').toLowerCase();
  const providerReason = String(data.reason || '').toLowerCase();
  const reasonDescriptions = {
    no_connect: 'Emailable could not connect to the destination mail server',
    timeout: 'the DNS or mail-server check timed out',
    unavailable_smtp: 'the destination mail server was temporarily unavailable',
    unexpected_error: 'Emailable encountered an unexpected verification error',
    rejected_email: 'the destination mail server rejected the address',
    accepted_email: 'the destination mail server accepted the address',
    invalid_email: 'the address did not pass email-format checks',
    invalid_domain: 'the email domain could not be verified for mail',
    invalid_smtp: 'the mail server returned an invalid SMTP response',
    low_deliverability: 'deliverability could not be confirmed with high confidence',
    low_quality: 'the address was flagged as low quality'
  };
  const providerReasonText = reasonDescriptions[providerReason] || '';
  const catchAll = data.accept_all === true;
  let status = 'UNKNOWN';
  let reason = 'Emailable could not confirm this mailbox. You can retry.';
  if (state === 'deliverable') {
    status = catchAll ? 'RISKY' : 'VALID';
    reason = catchAll
      ? 'Emailable reports this domain accepts all addresses; this mailbox is unconfirmed.'
      : 'Emailable reports this mailbox is deliverable.';
  } else if (state === 'undeliverable') {
    status = 'INVALID';
    reason = providerReasonText
      ? `Emailable reports this mailbox is undeliverable: ${providerReasonText}.`
      : 'Emailable reports this mailbox is undeliverable.';
  } else if (state === 'risky') {
    status = 'RISKY';
    reason = providerReasonText
      ? `Emailable reports this address as risky: ${providerReasonText}.`
      : 'Emailable reports this address as risky.';
  } else if (providerReasonText) {
    reason = `Emailable could not confirm this mailbox because ${providerReasonText}.`;
  }

  return {
    status,
    reason,
    mx: data.mx_record || undefined,
    catchAll,
    disposable: data.disposable === true,
    role: data.role === true,
    verificationProvider: 'Emailable',
    verificationState: state || 'unknown',
    verificationScore: data.score !== null && data.score !== undefined && Number.isFinite(Number(data.score))
      ? Number(data.score)
      : null
  };
}

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ MailProbe running on port ${PORT}`);
  console.log(`📧 Visit: http://localhost:${PORT}`);
});
