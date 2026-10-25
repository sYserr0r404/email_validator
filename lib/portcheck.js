import net from 'net';

/**
 * Check if outbound port 25 is accessible by testing against known public MX hosts
 * Returns { available: boolean, message: string, testedAt: string }
 */
export async function checkPort25() {
  const testHosts = [
    { host: 'gmail-smtp-in.l.google.com', port: 25 },
    { host: 'outlook-com.olc.protection.outlook.com', port: 25 }
  ];

  const results = [];

  for (const { host, port } of testHosts) {
    const canConnect = await testConnection(host, port, 5000);
    results.push({ host, canConnect });
  }

  const available = results.some(r => r.canConnect);

  let message;
  if (available) {
    message = 'Full SMTP verification active';
  } else {
    message = 'DNS-only mode: outbound port 25 is blocked on this server. Mailboxes cannot be confirmed. Deploy on a host that allows port 25 for full checks.';
  }

  return {
    available,
    message,
    testedAt: new Date().toISOString(),
    tests: results
  };
}

/**
 * Test TCP connection to a host:port with timeout
 */
function testConnection(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    
    const cleanup = () => {
      socket.destroy();
    };

    socket.on('connect', () => {
      cleanup();
      resolve(true);
    });

    socket.on('error', (err) => {
      cleanup();
      resolve(false);
    });

    socket.on('timeout', () => {
      cleanup();
      resolve(false);
    });
  });
}
