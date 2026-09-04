/**
 * SwiftPOS Print Bridge
 *
 * A local HTTP endpoint so the WEB POS can print silently. The desktop app does
 * not need this — it talks to printers directly from its main process.
 *
 * ── WHAT CHANGED FROM THE PREVIOUS PRINT SERVER ──────────────────────────────
 *
 * SIZE. The old server depended on node-html-to-image, which pulls in Puppeteer,
 * which bundles a headless Chromium — and the pkg config bundled
 * .local-chromium/**\/* into the executable. Roughly 300MB of browser whose only
 * job was rasterising receipt HTML. The POS now sends ESC/POS bytes, so that
 * entire tree is gone, along with express, cors and pdf-to-printer.
 *
 * This file has ZERO dependencies. Run it with an installed Node and it is a few
 * KB; build a single-file executable and it is only the Node runtime.
 *
 * SECURITY. Three holes are closed:
 *
 *   1. CORS was `origin.includes('localhost')`, a SUBSTRING test — so
 *      http://localhost.attacker.com passed. A page the cashier opened could
 *      post here. Origins are now matched exactly against a fixed list.
 *
 *   2. There was no authentication at all. A token is now required, generated
 *      on first run and pasted into the till's printer settings once.
 *
 *   3. The printer name from the request body was interpolated into a shell
 *      command, and the single-quote escaping did not work — backslash is
 *      literal inside single quotes in sh, so a name containing a quote broke
 *      out and ran arbitrary commands. NOTHING here spawns a process. Bytes go
 *      to a socket or a file handle, and the printer name is never parsed by
 *      anything.
 *
 * The body carries base64 ESC/POS produced by shared/printing. This process
 * does not know what a receipt is and never renders one.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { sendToPrinter, parseTarget, PrinterError } =
  require('../../../shared/printing/dist/src/transport.js');

const PORT = Number(process.env.PRINT_BRIDGE_PORT || 3001);
const VERSION = '2.0.0';
const MAX_BODY = 512 * 1024;

// Exact origins only. A substring test is what let localhost.attacker.com in.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:3000',
  ...(process.env.PRINT_BRIDGE_ORIGINS || '').split(',').filter(Boolean),
]);

// ─── Token ───────────────────────────────────────────────────────────────────
// Written next to the executable on first run and printed to the console so the
// installer can paste it into the till once. Losing it means deleting the file
// and restarting, not reinstalling.
const TOKEN_FILE = path.join(os.homedir(), '.swiftpos-print-bridge-token');

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch { /* first run */ }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

const TOKEN = loadToken();

/** Constant-time compare, so a wrong token cannot be discovered a byte at a
 *  time by measuring how long the rejection takes. */
function tokenOk(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
function send(res, status, body, origin) {
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Print-Token';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  // An origin that is present but not allowed is refused outright. Absent
  // origin (curl, the desktop app, a health check) still needs the token.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return send(res, 403, { error: 'origin not allowed' });
  }

  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, version: VERSION, requiresToken: true }, origin);
  }

  if (!tokenOk(req.headers['x-print-token'])) {
    return send(res, 401, { error: 'missing or invalid X-Print-Token' }, origin);
  }

  if (req.method === 'POST' && url.pathname === '/print') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }, origin); }

    const { target, data } = body;
    if (typeof target !== 'string' || typeof data !== 'string') {
      return send(res, 400, { error: 'target and data (base64 ESC/POS) are required' }, origin);
    }

    let bytes;
    try { bytes = Buffer.from(data, 'base64'); }
    catch { return send(res, 400, { error: 'data is not valid base64' }, origin); }
    if (!bytes.length) return send(res, 400, { error: 'data is empty' }, origin);

    const started = Date.now();
    try {
      await sendToPrinter(parseTarget(target), bytes);
      return send(res, 200, { ok: true, bytes: bytes.length, ms: Date.now() - started }, origin);
    } catch (e) {
      const retryable = e instanceof PrinterError ? e.retryable : true;
      return send(res, retryable ? 503 : 400, { error: e.message, retryable }, origin);
    }
  }

  // A209: server-side receipt render. The WEB POS sends the Order as JSON and this
  // process renders it with the SAME shared/printing renderTicket/toEscPos the
  // desktop till uses — so the bytes (and therefore the printed format) are
  // identical to desktop by construction, with no browser Buffer/bundle needed.
  if (req.method === 'POST' && url.pathname === '/print/receipt') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }, origin); }

    const { target, order, business, paperWidth } = body;
    if (typeof target !== 'string' || !order || !business) {
      return send(res, 400, { error: 'target, order and business are required' }, origin);
    }

    let bytes;
    try {
      const { renderTicket, toEscPos, receiptPreset } =
        require('../../../shared/printing/dist/src/index.js');
      const station = receiptPreset('web-receipt', 'Receipt', paperWidth === 58 ? 58 : 80);
      // soldAt crosses JSON as an ISO string; shared/printing wants a Date.
      const ord = { ...order, soldAt: order.soldAt ? new Date(order.soldAt) : new Date() };
      bytes = toEscPos(renderTicket({ order: ord, business, station }));
    } catch (e) {
      return send(res, 400, { error: 'render failed: ' + e.message }, origin);
    }
    if (!bytes || !bytes.length) return send(res, 500, { error: 'render produced no bytes' }, origin);

    const started = Date.now();
    try {
      await sendToPrinter(parseTarget(target), bytes);
      return send(res, 200, { ok: true, bytes: bytes.length, ms: Date.now() - started }, origin);
    } catch (e) {
      const retryable = e instanceof PrinterError ? e.retryable : true;
      return send(res, retryable ? 503 : 400, { error: e.message, retryable }, origin);
    }
  }

  return send(res, 404, { error: 'not found' }, origin);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SwiftPOS Print Bridge ${VERSION} on http://127.0.0.1:${PORT}`);
  console.log(`Bound to loopback only. Not reachable from the network.`);
  console.log(``);
  console.log(`Pair token (paste into the till's printer settings):`);
  console.log(`   ${TOKEN}`);
  console.log(``);
  console.log(`Stored at ${TOKEN_FILE}. Delete it and restart to rotate.`);
});
