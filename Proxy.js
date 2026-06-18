#!/usr/bin/env node
/**
 * AutoTrader Proxy
 * Bridges Alpaca API + Yahoo Finance for the claude.ai artifact.
 *
 * ZERO dependencies — just Node.js (v14+)
 *
 * Usage:
 *   node proxy.js
 *
 * Routes:
 *   GET  /health                          — check if proxy is running
 *   GET  /yahoo?symbol=SPY&interval=5m&range=1d  — Yahoo Finance OHLCV
 *   *    /alpaca/v2/account               — Alpaca account info
 *   *    /alpaca/v2/positions             — open positions
 *   *    /alpaca/v2/orders                — orders (GET / POST)
 *   DEL  /alpaca/v2/orders/:id            — cancel order
 *   DEL  /alpaca/v2/positions/:symbol     — close position
 *
 * Alpaca keys are passed as request headers from the artifact:
 *   APCA-API-KEY-ID, APCA-API-SECRET-KEY, x-alpaca-paper
 */

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = process.env.PORT || 3001;

// ─── HTTPS helper ────────────────────────────────────────────────────────────

function request(method, hostname, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      hostname,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Read incoming body ───────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
  });
}

// ─── Send JSON response ───────────────────────────────────────────────────────

function send(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload || '{}');
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {

  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,APCA-API-KEY-ID,APCA-API-SECRET-KEY,x-alpaca-paper');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {

    // ── Health check ─────────────────────────────────────────────────────────
    if (pathname === '/health') {
      return send(res, 200, { ok: true, time: new Date().toISOString() });
    }

    // ── Yahoo Finance ─────────────────────────────────────────────────────────
    if (pathname === '/yahoo') {
      const { symbol, interval = '5m', range = '1d' } = parsed.query;

      if (!symbol) return send(res, 400, { error: 'symbol query param required' });

      const yPath = `/v8/finance/chart/${encodeURIComponent(symbol)}` +
                    `?interval=${interval}&range=${range}&includePrePost=false`;

      const { status, body } = await request(
        'GET',
        'query1.finance.yahoo.com',
        yPath,
        { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
      );

      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(body);
    }

    // ── Alpaca proxy ──────────────────────────────────────────────────────────
    if (pathname.startsWith('/alpaca')) {
      const keyId  = req.headers['apca-api-key-id'];
      const secret = req.headers['apca-api-secret-key'];
      const paper  = (req.headers['x-alpaca-paper'] || 'true') !== 'false';

      if (!keyId || !secret) {
        return send(res, 401, { error: 'Missing APCA-API-KEY-ID or APCA-API-SECRET-KEY headers' });
      }

      const host      = paper ? 'paper-api.alpaca.markets' : 'api.alpaca.markets';
      const alpacaPath = pathname.replace('/alpaca', '') + (parsed.search || '');
      const body      = await readBody(req);

      console.log(`  ${req.method} ${host}${alpacaPath}`);

      const { status, body: respBody } = await request(
        req.method,
        host,
        alpacaPath,
        { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret },
        ['POST', 'PUT', 'PATCH'].includes(req.method) ? body : null
      );

      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(respBody || '{}');
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    return send(res, 404, { error: `Unknown route: ${pathname}` });

  } catch (err) {
    console.error('Proxy error:', err.message);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const os   = require('os');
  const nets = os.networkInterfaces();
  const lan  = Object.values(nets).flat()
    .filter(n => n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

  const lanLine = lan.length
    ? `║   iPhone/iPad (same WiFi): http://${lan[0]}:${PORT}\n`
    : '';

  console.log(`
╔══════════════════════════════════════════════════════╗
║            AutoTrader Proxy  ✓  Running              ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║   This Mac:  http://localhost:${PORT}                   ║
${lanLine}║                                                      ║
║   Paste the iPhone URL into the artifact's           ║
║   Settings → Proxy URL field, then hit Connect.      ║
║                                                      ║
║   Press Ctrl+C to stop.                              ║
╚══════════════════════════════════════════════════════╝
`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗  Port ${PORT} already in use.`);
    console.error(`   Either another proxy is running (that's fine!)`);
    console.error(`   or kill the process using that port and retry.\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
