import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
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
const SMTP_TIMEOUT = parseInt(process.env.SMTP_TIMEOUT_MS || '8000');

// Global state
let smtpMode = 'checking'; // 'checking', 'full', 'dns-only'
let port25Status = null;

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
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

// POST /api/check - Main verification endpoint
app.post('/api/check', async (req, res) => {
  try {
    let { emails } = req.body;

    // Accept string or array
    if (typeof emails === 'string') {
      // Split by newline, comma, semicolon, or space
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

    // Dedupe
    emails = [...new Set(emails)];

    if (emails.length === 0) {
      return res.status(400).json({ error: 'No email addresses provided' });
    }

    if (emails.length > 50) {
      return res.status(400).json({ 
        error: 'Too many addresses. Maximum 50 emails per request.' 
      });
    }

    // Process emails with concurrency limit
    const results = [];
    const concurrency = 5;
    const domainLocks = new Map(); // One probe per domain at a time

    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(email => checkEmail(email, domainLocks))
      );
      results.push(...batchResults);
    }

    res.json({ 
      mode: smtpMode,
      results 
    });
  } catch (error) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Check single email through the complete pipeline
 */
async function checkEmail(email, domainLocks) {
  const startTime = Date.now();
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
      const { status, reason } = classify({ syntax, smtpMode });
      result.status = status;
      result.reason = reason;
      return result;
    }

    const { local, domain } = syntax;

    // 2. Role account check (informational only)
    result.role = isRoleAccount(local);

    // 3. Disposable domain check
    result.disposable = isDisposable(domain);
    if (result.disposable) {
      const { status, reason } = classify({ syntax, disposable: true, smtpMode });
      result.status = status;
      result.reason = reason;
      return result;
    }

    // 4. Typo check
    const typo = await checkTypo(email);
    result.typoSuggestion = typo.suggestion;
    if (typo.suggestion) {
      const { status, reason } = classify({ 
        syntax, 
        disposable: false, 
        typoSuggestion: typo.suggestion,
        smtpMode 
      });
      result.status = status;
      result.reason = reason;
      return result;
    }

    // 5. DNS checks
    const dns = await checkDNS(domain);
    result.spf = !!dns.spf;
    result.dmarc = !!dns.dmarc;

    if (dns.error || dns.mx.length === 0) {
      const { status, reason } = classify({ 
        syntax, 
        disposable: false, 
        typoSuggestion: null,
        dns,
        smtpMode 
      });
      result.status = status;
      result.reason = reason;
      return result;
    }

    result.mx = dns.mx[0].exchange;

    // 6. Big provider check (skip SMTP for these)
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
        smtpMode 
      });
      result.status = status;
      result.reason = reason;
      return result;
    }

    // 7. SMTP probe (only in full mode)
    let smtp = null;
    if (smtpMode === 'full') {
      // Domain lock: wait if another check is already probing this domain
      if (!domainLocks.has(domain)) {
        domainLocks.set(domain, Promise.resolve());
      }

      await domainLocks.get(domain);

      const probePromise = (async () => {
        try {
          const sender = process.env.PROBE_MAIL_FROM;
          
          // 15 second hard timeout per address
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Timeout (15s) verifying ${email}`)), 15000)
          );

          // Use resilient probing with multiple MX hosts
          smtp = await Promise.race([
            probeMailboxResilient(email, dns.mx, sender, SMTP_TIMEOUT),
            timeoutPromise
          ]);

          result.smtpCode = smtp.code;
          result.enhancedCode = smtp.enhancedCode;
          result.tls = smtp.tls;
          result.catchAll = smtp.catchAll;
          
          // Store additional data for JSON export (not shown in UI)
          result._smtpDetails = {
            mxHost: smtp.mxHost,
            attempts: smtp.attempts?.length || 0,
            rawReplies: smtp.rawReplies || []
          };

          // 2 second gap before next probe to same domain
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
          smtp = { error: err.message, accepted: false };
        }
      })();

      domainLocks.set(domain, probePromise);
      await probePromise;
    }

    // 8. Final classification
    const { status, reason } = classify({ 
      syntax, 
      disposable: false, 
      typoSuggestion: null,
      dns,
      smtp,
      domain,
      smtpMode 
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
