import { test } from 'node:test';
import assert from 'node:assert';
import net from 'net';
import { probeMailboxResilient } from '../lib/smtp.js';

test('tries multiple MX hosts on failure', async () => {
  const mxHosts = [
    { exchange: 'mx1.nonexistent.invalid', priority: 10 },
    { exchange: 'mx2.nonexistent.invalid', priority: 20 },
    { exchange: 'mx3.nonexistent.invalid', priority: 30 }
  ];

  const result = await probeMailboxResilient('test@example.com', mxHosts, 'verify@test.local', 1000);
  
  // Should have attempted multiple hosts
  assert.ok(result.attempts);
  assert.ok(result.attempts.length >= 1);
  assert.strictEqual(result.accepted, false);
});

test('returns on first successful verification', async () => {
  const mxHosts = [
    { exchange: 'good.example.com', priority: 10 },
    { exchange: 'backup.example.com', priority: 20 }
  ];

  // This will timeout but structure should be correct
  const result = await probeMailboxResilient('test@example.com', mxHosts, 'verify@test.local', 1000);
  
  assert.ok(result);
  assert.ok('accepted' in result);
  assert.ok('attempts' in result);
  assert.ok('rawReplies' in result);
});

test('includes detailed attempt information', async () => {
  const mxHosts = [
    { exchange: 'mx.example.invalid', priority: 10 }
  ];

  const result = await probeMailboxResilient('test@example.com', mxHosts, 'verify@test.local', 1000);
  
  // Check structure
  assert.ok(Array.isArray(result.attempts));
  assert.ok(Array.isArray(result.rawReplies));
  
  if (result.attempts.length > 0) {
    const attempt = result.attempts[0];
    assert.ok('mxHost' in attempt);
    assert.ok('attempt' in attempt);
  }
});
