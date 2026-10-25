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
const PROBE_TIMEOUT = parseInt(process.env.PROBE_TIMEOUT_MS || '20000'); // 20s per probe
const DOMAIN_GAP = 2000; // 2s gap between probes to same domain

// Job store: { jobId: { status, results, queue, domainTimers, mode, createdAt } }
const jobs = new Map();

// Global state
let smtpMode = 'checking';
let port25Status = null;

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
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

// GET /api/status - Return current mode and port 25 status
app.get('/api/status', (req, res) => {
  res.json({
    mode: smtpMode,
    smtpAvailable: smtpMode === 'full',
    message: port25Status?.message || 'Checking...',
    checkedAt: port25Status?.testedAt || null
  });
});

// POST /api/jobs - Create a new verification job
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

    if (!Array.isArray(emails)) {
      return res.status(400).json({ 
        error: 'Invalid input: emails must be an array or newline/comma/semicolon separated string' 
      });
    }

    emails = [...new Set(emails)];

    if (emails.length === 0) {
      return res.status(400).json({ error: 'No email addresses provided' });
    }

    if (emails.length > 50) {
      return res.status(400).json({ 
        error: 'Too many addresses. Maximum 50 emails per request.' 
      });
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

    jobs.set(jobId, {
      jobId,
      status: 'queued',
      results: emailMap,
      queue: [...emails],
      domainTimers: new Map(),
      createdAt: Date.now(),
      mode: smtpMode
    });

    processJob(jobId).catch(err => console.error(`Job ${jobId} error:`, err));

    res.json({ jobId });
  } catch (error) {
    console.error('Job creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/jobs/:id - Get job status and results
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const results = Array.from(job.results.values());
  res.json({
    jobId: job.jobId,
    status: job.status,
    results,
    mode: job.mode,
    progress: {
      total: job.results.size,
      completed: results.filter(r => r.status !== 'QUEUED' && r.status !== 'CHECKING').length,
      done: job.status === 'done'
    }
  });
});

// POST /api/jobs/:id/retry-unknown - Retry only UNKNOWN results
app.post('/api/jobs/:id/retry-unknown', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const unknowns = Array.from(job.results.values())
    .filter(r => r.status === 'UNKNOWN')
    .map(r => r.email);

  if (unknowns.length === 0) {
    return res.json({ message: 'No UNKNOWN results to retry', count: 0 });
  }

  unknowns.forEach(email => {
    job.queue.push(email);
    job.results.get(email).status = 'QUEUED';
    job.results.get(email).reason = 'Retrying...';
  });

  job.status = 'queued';
  processJob(req.params.id).catch(err => console.error(`Job ${req.params.id} retry error:`, err));

  res.json({ message: 'Retrying UNKNOWN results', count: unknowns.length });
});

// POST /api/check (legacy) - Returns immediately with job ID
app.post('/api/check', (req, res) => {
  try {
    let { emails } = req.body;

    if (typeof emails === 'string') {
      emails = emails.split(/[\n,;]+/).flatMap(e => e.split(/\s+/)).map(e => e.trim()).filter(e => e.length > 0);
    }

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    emails = [...new Set(emails)];
    if (emails.length > 50) {
      return res.status(400).json({ error: 'Too many addresses. Maximum 50 emails per request.' });
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

    jobs.set(jobId, {
      jobId,
      status: 'queued',
      results: emailMap,
      queue: [...emails],
      domainTimers: new Map(),
      createdAt: Date.now(),
      mode: smtpMode
    });

    processJob(jobId).catch(err => console.error(`Job ${jobId} error:`, err));

    // For legacy API compatibility, return job ID and initial results
    const results = Array.from(emailMap.values());
    res.json({ jobId, mode: smtpMode, results });
  } catch (error) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Process a job queue asynchronously
 * Timer starts only when SMTP probe actually begins
 */
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'running';

  while (job.queue.length > 0) {
    const email = job.queue.shift();
    const result = job.results.get(email);

    // Wait for domain gap (between probes to same domain)
    const domain = email.split('@')[1];
    const lastProbe = job.domainTimers.get(domain) || 0;
    const waitTime = Math.max(0, DOMAIN_GAP - (Date.now() - lastProbe));
    
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    result.status = 'CHECKING';

    // TIMER STARTS HERE (when SMTP probe begins)
    try {
      const verified = await checkEmail(email, job.mode, PROBE_TIMEOUT);
      Object.assign(result, verified);
    } catch (err) {
      result.status = 'UNKNOWN';
      result.reason = 'Verification error';
      console.error(`Error checking ${email}:`, err);
    }

    job.domainTimers.set(domain, Date.now());
  }

  job.status = 'done';
}

/**
 * Check single email through the complete pipeline
 * SMTP timeout timer starts only when probe begins
 */
async function checkEmail(email, mode, probeTimeout) {
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
    // 1. Syntax validation
    const syntax = validateSyntax(email);
    if (!syntax.valid) {
      const { status, reason } = classify({ syntax, smtpMode: mode });
      result.status = status;
      result.reason = reason;
      return result;
    }

    const { local, domain } = syntax;
    result.role = isRoleAccount(local);

    // 2. Disposable domain check
    result.disposable = isDisposable(domain);
    if (result.disposable) {
      const { status, reason } = classify({ syntax, disposable: true, smtpMode: mode });
      result.status = status;
      result.reason = reason;
      return result;
    }

    // 3. Typo check
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

    // 4. DNS checks
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

    // 5. Big provider check (skip SMTP for these)
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

    // 6. SMTP probe (only in full mode) - TIMER STARTS HERE
    let smtp = null;
    if (mode === 'full') {
      try {
        const sender = process.env.PROBE_MAIL_FROM;
        
        // 20 second timeout - timer starts NOW
        smtp = await Promise.race([
          probeMailboxResilient(email, dns.mx, sender, probeTimeout),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Server did not respond')), probeTimeout)
          )
        ]);

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
        smtp = { error: err.message, accepted: false };
      }
    }

    // 7. Final classification
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

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ MailProbe running on port ${PORT}`);
  console.log(`📧 Visit: http://localhost:${PORT}`);
});
