import { test } from 'node:test';
import assert from 'node:assert';
import { classify } from '../lib/classify.js';

test('classifies syntax error as INVALID', () => {
  const result = classify({
    syntax: { valid: false, reason: 'Missing domain' },
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'INVALID');
  assert.strictEqual(result.reason, 'Missing domain');
});

test('classifies disposable domain as INVALID', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: true,
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'INVALID');
  assert.match(result.reason, /disposable/i);
});

test('classifies domain not found as INVALID', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { error: 'domain-not-found', mx: [] },
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'INVALID');
  assert.match(result.reason, /not exist/i);
});

test('classifies null MX as INVALID', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { error: 'null-mx', mx: [{ exchange: '.', priority: 0 }] },
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'INVALID');
  assert.match(result.reason, /null mx/i);
});

test('classifies 550 rejection as INVALID', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { mx: [{ exchange: 'mail.example.com', priority: 10 }] },
    smtp: { accepted: false, code: 550, enhancedCode: '5.1.1', error: null },
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'INVALID');
  assert.match(result.reason, /not exist/i);
});

test('classifies typo as RISKY', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    typoSuggestion: 'user@gmail.com',
    dns: { mx: [{ exchange: 'mail.example.com', priority: 10 }] },
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'RISKY');
  assert.match(result.reason, /typo/i);
  assert.match(result.reason, /gmail.com/);
});

test('classifies catch-all as RISKY', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { mx: [{ exchange: 'mail.example.com', priority: 10 }] },
    smtp: { accepted: true, catchAll: true, error: null },
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'RISKY');
  assert.match(result.reason, /catch-all/i);
});

test('classifies big provider as RISKY', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { mx: [{ exchange: 'gmail-smtp-in.l.google.com', priority: 10 }] },
    domain: 'gmail.com',
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'RISKY');
  assert.match(result.reason, /not confirm/i);
});

test('classifies dns-only mode as UNKNOWN', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { mx: [{ exchange: 'mail.example.com', priority: 10 }] },
    smtpMode: 'dns-only'
  });
  assert.strictEqual(result.status, 'UNKNOWN');
  assert.match(result.reason, /port 25/i);
});

test('classifies 4xx greylist as UNKNOWN', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { mx: [{ exchange: 'mail.example.com', priority: 10 }] },
    smtp: { accepted: false, code: 450, error: null },
    domain: 'example.com',
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'UNKNOWN');
  assert.match(result.reason, /retry later/i);
});

test('classifies SMTP timeout as UNKNOWN', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { mx: [{ exchange: 'mail.example.com', priority: 10 }] },
    smtp: { accepted: false, error: 'Connection timeout to mail.example.com:25' },
    domain: 'example.com',
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'UNKNOWN');
  assert.match(result.reason, /did not respond/i);
});

test('classifies 5.7.x policy block as UNKNOWN', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { mx: [{ exchange: 'mail.example.com', priority: 10 }] },
    smtp: { accepted: false, code: 550, enhancedCode: '5.7.1', error: null },
    domain: 'example.com',
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'UNKNOWN');
  assert.match(result.reason, /blocked/i);
});

test('classifies verified mailbox as VALID', () => {
  const result = classify({
    syntax: { valid: true },
    disposable: false,
    dns: { mx: [{ exchange: 'mail.example.com', priority: 10 }] },
    smtp: { accepted: true, catchAll: false, code: 250, error: null },
    domain: 'example.com',
    smtpMode: 'full'
  });
  assert.strictEqual(result.status, 'VALID');
  assert.match(result.reason, /verified/i);
});
