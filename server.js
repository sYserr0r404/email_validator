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

// Job store
const jobs = new Map();
const domainQueues = new Map();

let smtpMode = 'checking';
let port25Status = null;

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

// Check port 25 on startup
(async () => {
  console.log('🔍 Checking outbound port 25 availability...');
  port25Status = await checkPort25();
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
    smtpAvailable: smtpMode === 'full',
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

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ MailProbe running on port ${PORT}`);
  console.log(`📧 Visit: http://localhost:${PORT}`);
});
