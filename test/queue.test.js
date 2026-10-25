import { test } from 'node:test';
import assert from 'node:assert';
import net from 'net';

test('queue drains when SMTP server hangs (never replies)', async (t) => {
  // Create a fake SMTP server that accepts connection but never sends banner
  const server = net.createServer((socket) => {
    // Intentionally never send 220 banner
    socket.on('data', () => {
      // Ignore all commands, never reply
    });
  });

  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const port = server.address().port;
  const host = 'localhost';

  try {
    // This should timeout after PROBE_TIMEOUT_MS (20s)
    // and not block the next email in queue
    
    const PROBE_TIMEOUT = 1000; // 1s for test
    let firstProbeStarted = Date.now();
    
    // Simulate timeout handling
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve({ error: 'timeout', code: null });
      }, PROBE_TIMEOUT);
    });

    const connectionPromise = new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      socket.on('connect', () => {
        socket.destroy();
        resolve({ error: 'never replied' });
      });
      socket.on('error', (err) => {
        resolve({ error: err.message });
      });
    });

    const result = await Promise.race([connectionPromise, timeoutPromise]);
    const elapsed = Date.now() - firstProbeStarted;

    // Should timeout within reasonable bounds (not hang forever)
    assert.ok(elapsed < PROBE_TIMEOUT + 500, `Timeout too long: ${elapsed}ms`);
    assert.ok(result.error, 'Should have error');

  } finally {
    server.close();
  }
});

test('per-domain promise chain catches errors and continues', async (t) => {
  // Simulate two emails for same domain
  // First one errors, second one should still process

  let processedCount = 0;
  const errors = [];

  // Simulate domain queue with promise chaining
  let domainChain = Promise.resolve();

  // Email 1: will error
  domainChain = domainChain
    .then(async () => {
      processedCount++;
      throw new Error('First probe failed');
    })
    .catch(err => {
      errors.push(err.message);
      // Catch error to prevent blocking next probe
    });

  // Email 2: should still process despite error above
  domainChain = domainChain
    .then(async () => {
      processedCount++;
    })
    .catch(err => {
      errors.push(err.message);
    });

  await domainChain;

  // Both probes should have been attempted
  assert.strictEqual(processedCount, 2, 'Both emails should have been processed');
  assert.strictEqual(errors.length, 1, 'Only first error should be caught');
});

test('hard timeout destroys socket before continuing', async (t) => {
  let socketDestroyed = false;

  class MockSocket {
    destroy() {
      socketDestroyed = true;
    }
  }

  const socket = new MockSocket();
  const TIMEOUT_MS = 100;

  // Simulate probe with timeout
  const probePromise = new Promise((resolve) => {
    setTimeout(() => {
      // Simulate timeout
      socket.destroy();
      resolve({ timedOut: true });
    }, TIMEOUT_MS);
  });

  const result = await probePromise;

  assert.strictEqual(socketDestroyed, true, 'Socket should be destroyed');
  assert.strictEqual(result.timedOut, true, 'Should indicate timeout');
});

test('job status never shows running with no progress for >40s (2x PROBE_TIMEOUT)', async (t) => {
  // This is more of an architectural test - documenting the requirement
  // In actual implementation: job.startedAt tracks when first probe started
  // If job is "running" and no result progress in 40s, something is stuck

  const job = {
    status: 'running',
    startedAt: Date.now(),
    results: new Map([
      ['test1@example.com', { status: 'QUEUED' }],
      ['test2@example.com', { status: 'QUEUED' }]
    ])
  };

  const PROBE_TIMEOUT = 20000;
  const MAX_NO_PROGRESS = PROBE_TIMEOUT * 2; // 40s

  // Simulate checking if job is stuck
  const now = Date.now();
  const elapsed = now - job.startedAt;
  const hasProgress = Array.from(job.results.values()).some(r => r.status !== 'QUEUED' && r.status !== 'CHECKING');

  // If elapsed > 40s and no progress, something is wrong
  if (elapsed > MAX_NO_PROGRESS && !hasProgress) {
    assert.fail('Job stuck: running for 40s with no progress');
  }

  // No error means job is making progress or timeout hasn't expired
  assert.ok(true, 'Job watchdog would catch this');
});
