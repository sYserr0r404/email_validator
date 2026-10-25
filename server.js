import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PROBE_SERVER_URL = process.env.PROBE_SERVER_URL || 'http://localhost:3001';
const PROBE_TOKEN = process.env.PROBE_TOKEN || 'dev-token';

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting (applies to both Vercel and local dev)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', limiter);

// Forward request to probe server
async function forwardToProbe(req, res, method, path, body = null) {
  return new Promise((resolve) => {
    const url = new URL(PROBE_SERVER_URL);
    url.pathname = `/api${path}`;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-probe-token': PROBE_TOKEN
      }
    };

    const protocol = url.protocol === 'https:' ? https : http;
    const proxyReq = protocol.request(url, options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode);
        res.set(proxyRes.headers);
        res.send(data);
        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      console.error('Probe server error:', err);
      res.status(503).json({ error: 'Probe server unavailable' });
      resolve();
    });

    proxyReq.setTimeout(25000); // 20s probe + buffer
    if (body) {
      proxyReq.write(JSON.stringify(body));
    }
    proxyReq.end();
  });
}

// GET /api/status - Local status only (don't need to forward)
app.get('/api/status', (req, res) => {
  res.json({
    mode: 'delegated',
    message: 'Requests forwarded to probe server',
    probeServerUrl: PROBE_SERVER_URL
  });
});

// POST /api/jobs - Forward to probe server
app.post('/api/jobs', async (req, res) => {
  await forwardToProbe(req, res, 'POST', '/jobs', req.body);
});

// GET /api/jobs/:id - Forward to probe server
app.get('/api/jobs/:id', async (req, res) => {
  await forwardToProbe(req, res, 'GET', `/jobs/${req.params.id}`);
});

// POST /api/jobs/:id/retry-unknown - Forward to probe server
app.post('/api/jobs/:id/retry-unknown', async (req, res) => {
  await forwardToProbe(req, res, 'POST', `/jobs/${req.params.id}/retry-unknown`, req.body);
});

// POST /api/check (legacy) - Forward to probe server
app.post('/api/check', async (req, res) => {
  await forwardToProbe(req, res, 'POST', '/jobs', req.body);
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Vercel proxy running on port ${PORT}`);
  console.log(`📧 Forwarding to probe server: ${PROBE_SERVER_URL}`);
});
