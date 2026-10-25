import net from 'net';
import tls from 'tls';
import { randomBytes } from 'crypto';

const ALLOWED_COMMANDS = ['EHLO', 'STARTTLS', 'MAIL', 'RCPT', 'RSET', 'QUIT'];

/**
 * Probe SMTP server to verify mailbox
 * Returns { accepted, code, enhancedCode, message, tls, catchAll, error }
 */
export async function probeMailbox(email, mxHost, sender, timeoutMs = 8000) {
  let socket = null;
  let secure = false;

  try {
    // Connect to MX
    socket = await connectWithTimeout(mxHost, 25, timeoutMs);
    
    // Read banner
    const banner = await readResponse(socket, timeoutMs);
    if (!banner.startsWith('220')) {
      throw new Error(`Unexpected banner: ${banner}`);
    }

    // EHLO
    const heloHost = process.env.PROBE_HELO_HOST || 'mailprobe.local';
    await sendCommand(socket, `EHLO ${heloHost}`, timeoutMs);
    const ehloResponse = await readResponse(socket, timeoutMs);
    
    // Check for STARTTLS
    if (ehloResponse.includes('STARTTLS')) {
      await sendCommand(socket, 'STARTTLS', timeoutMs);
      const starttlsResponse = await readResponse(socket, timeoutMs);
      
      if (starttlsResponse.startsWith('220')) {
        // Upgrade to TLS
        socket = await upgradeToTLS(socket, mxHost, timeoutMs);
        secure = true;
        
        // Send EHLO again after STARTTLS
        await sendCommand(socket, `EHLO ${heloHost}`, timeoutMs);
        await readResponse(socket, timeoutMs);
      }
    }

    // MAIL FROM
    const mailFrom = sender || process.env.PROBE_MAIL_FROM || 'verify@mailprobe.local';
    await sendCommand(socket, `MAIL FROM:<${mailFrom}>`, timeoutMs);
    const mailResponse = await readResponse(socket, timeoutMs);
    
    if (!mailResponse.startsWith('250')) {
      throw new Error(`MAIL FROM rejected: ${mailResponse}`);
    }

    // RCPT TO (target address)
    await sendCommand(socket, `RCPT TO:<${email}>`, timeoutMs);
    const rcptResponse = await readResponse(socket, timeoutMs);
    
    const code = parseInt(rcptResponse.substring(0, 3));
    const enhancedCode = extractEnhancedCode(rcptResponse);
    const accepted = code === 250 || code === 251;

    // Catch-all detection: only if target was accepted
    let catchAll = false;
    if (accepted) {
      const randomLocal = `zz-${randomBytes(8).toString('hex')}`;
      const randomEmail = `${randomLocal}@${email.split('@')[1]}`;
      
      // RSET first
      await sendCommand(socket, 'RSET', timeoutMs);
      await readResponse(socket, timeoutMs);
      
      // MAIL FROM again
      await sendCommand(socket, `MAIL FROM:<${mailFrom}>`, timeoutMs);
      await readResponse(socket, timeoutMs);
      
      // RCPT TO with random address
      await sendCommand(socket, `RCPT TO:<${randomEmail}>`, timeoutMs);
      const randomResponse = await readResponse(socket, timeoutMs);
      const randomCode = parseInt(randomResponse.substring(0, 3));
      
      if (randomCode === 250 || randomCode === 251) {
        catchAll = true;
      }
    }

    // QUIT
    await sendCommand(socket, 'QUIT', timeoutMs);
    socket.destroy();

    return {
      accepted,
      code,
      enhancedCode,
      message: rcptResponse,
      tls: secure,
      catchAll,
      error: null
    };

  } catch (err) {
    if (socket) socket.destroy();
    
    let error = err.message;
    if (err.code === 'ETIMEDOUT') {
      error = `Connection timeout to ${mxHost}:25`;
    } else if (err.code === 'ECONNREFUSED') {
      error = `Connection refused by ${mxHost}:25`;
    } else if (err.code === 'ENOTFOUND') {
      error = `MX host ${mxHost} not found`;
    }

    return {
      accepted: false,
      code: null,
      enhancedCode: null,
      message: null,
      tls: false,
      catchAll: false,
      error
    };
  }
}

function connectWithTimeout(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    
    socket.once('connect', () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    
    socket.once('timeout', () => {
      socket.destroy();
      const err = new Error('Connection timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    });
    
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

function upgradeToTLS(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket,
      host,
      rejectUnauthorized: false,
      timeout: timeoutMs
    });

    tlsSocket.once('secureConnect', () => {
      tlsSocket.setTimeout(0);
      resolve(tlsSocket);
    });

    tlsSocket.once('timeout', () => {
      tlsSocket.destroy();
      reject(new Error('TLS timeout'));
    });

    tlsSocket.once('error', (err) => {
      tlsSocket.destroy();
      reject(err);
    });
  });
}

async function sendCommand(socket, command, timeoutMs) {
  const cmd = command.split(' ')[0];
  if (!ALLOWED_COMMANDS.includes(cmd)) {
    throw new Error(`Forbidden SMTP command: ${cmd}. Only ${ALLOWED_COMMANDS.join(', ')} are allowed.`);
  }
  
  socket.write(command + '\r\n');
}

function readResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Response timeout'));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString();
      
      // SMTP responses end with \r\n, and multi-line ends with code + space
      const lines = buffer.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (line.length >= 4 && line[3] === ' ') {
          // Complete response
          cleanup();
          resolve(buffer.trim());
          return;
        }
      }
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
    };

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function extractEnhancedCode(response) {
  // Enhanced status codes: X.Y.Z format (RFC 3463)
  const match = response.match(/\b([245]\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}
