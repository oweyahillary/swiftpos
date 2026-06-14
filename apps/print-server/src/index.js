/**
 * SwiftPOS Print Server
 * 
 * A lightweight local HTTP server that receives print jobs from the SwiftPOS
 * browser dashboard and sends them to Windows/Mac/Linux printers.
 * 
 * Runs on http://localhost:3001
 * 
 * Endpoints:
 *   GET  /health           — health check, returns printer list
 *   GET  /printers         — list all available printers
 *   POST /print            — print a job
 *   POST /print/test       — print a test page
 * 
 * The browser dashboard auto-detects this server on startup.
 * If running → silent one-click printing.
 * If not running → falls back to window.print() browser dialog.
 */

const express  = require('express');
const cors     = require('cors');
const { exec } = require('child_process');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');
const http     = require('http');

const app  = express();
const PORT = 3001;
const VERSION = '1.0.0';

// ─── CORS — only allow localhost origins ──────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-machine curl, Electron, etc.)
    // and any localhost / 127.0.0.1 origin
    if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
}));

app.use(express.json({ limit: '10mb' }));

// ─── Detect platform ──────────────────────────────────────────────────────────
const isWindows = os.platform() === 'win32';
const isMac     = os.platform() === 'darwin';
const isLinux   = os.platform() === 'linux';

// ─── Get list of installed printers ──────────────────────────────────────────
function getPrinters() {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(
        'wmic printer get Name /format:csv',
        { timeout: 5000 },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          const lines  = stdout.split('\n').filter(l => l.trim() && !l.includes('Name'));
          const names  = lines.map(l => l.split(',').pop()?.trim()).filter(Boolean);
          resolve(names);
        }
      );
    } else if (isMac || isLinux) {
      exec('lpstat -a 2>/dev/null | awk \'{print $1}\'', { timeout: 5000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        const names = stdout.split('\n').map(l => l.trim()).filter(Boolean);
        resolve(names);
      });
    } else {
      resolve([]);
    }
  });
}

// ─── Build ESC/POS raw bytes from plain text ──────────────────────────────────
// Used for direct raw printing (faster, no Windows GDI overhead)
function buildEscPos(text, opts = {}) {
  const { paperWidth = 80, autoCut = true } = opts;

  const ESC = '\x1b';
  const GS  = '\x1d';

  const INIT          = `${ESC}@`;
  const ALIGN_LEFT    = `${ESC}a\x00`;
  const ALIGN_CENTER  = `${ESC}a\x01`;
  const BOLD_ON       = `${ESC}E\x01`;
  const BOLD_OFF      = `${ESC}E\x00`;
  const DBL_HEIGHT_ON = `${ESC}!\x10`;
  const DBL_HEIGHT_OFF= `${ESC}!\x00`;
  const CUT           = `${GS}V\x00`;

  const lineWidth = paperWidth === 58 ? 32 : 48;
  const lines     = text.split('\n');

  let out = INIT;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) { out += '\n'; continue; }

    const isHeading = trimmed.length <= 24 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed);
    const isDivider = /^[-=─]{3,}$/.test(trimmed);
    const isTotal   = /^TOTAL/i.test(trimmed);

    if (isHeading && !isDivider) {
      out += ALIGN_CENTER + BOLD_ON + DBL_HEIGHT_ON + trimmed + '\n' + DBL_HEIGHT_OFF + BOLD_OFF + ALIGN_LEFT;
    } else if (isDivider) {
      out += ALIGN_LEFT + '-'.repeat(lineWidth) + '\n';
    } else if (isTotal) {
      out += BOLD_ON + trimmed + '\n' + BOLD_OFF;
    } else {
      out += ALIGN_LEFT + trimmed + '\n';
    }
  }

  out += '\n\n\n';
  if (autoCut) out += CUT;

  return out;
}

// ─── Print via Windows: write temp file + print command ──────────────────────
function printOnWindows(printerName, content, opts) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `swiftpos_print_${Date.now()}.txt`);
    const escaped  = printerName.replace(/"/g, '\\"');

    // Write content to temp file
    fs.writeFileSync(tmpFile, content, 'binary');

    // Use powershell to send to printer
    const cmd = `powershell -Command "Get-Content '${tmpFile}' -Encoding Byte | Out-Printer -Name '${escaped}'"`;

    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch { /* silent */ }

      if (err) {
        reject(new Error(`Print failed: ${stderr || err.message}`));
      } else {
        resolve({ ok: true });
      }
    });
  });
}

// ─── Print via CUPS (Mac / Linux) ─────────────────────────────────────────────
function printOnCups(printerName, content, opts) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `swiftpos_print_${Date.now()}.txt`);
    const escaped  = printerName.replace(/"/g, '\\"').replace(/'/g, "\\'");
    const copies   = opts.copies || 1;

    fs.writeFileSync(tmpFile, content, 'binary');

    const cmd = `lp -d '${escaped}' -n ${copies} '${tmpFile}'`;

    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch { /* silent */ }
      if (err) {
        reject(new Error(`Print failed: ${stderr || err.message}`));
      } else {
        resolve({ ok: true });
      }
    });
  });
}

// ─── Strip HTML to plain text ─────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\t/g, '  ')
    .split('\n')
    .map(l => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ─── Core print function ──────────────────────────────────────────────────────
async function doPrint(printerName, htmlContent, opts = {}) {
  const { paperWidth = 80, copies = 1, autoCut = true } = opts;

  // Convert HTML to plain text → ESC/POS
  const plainText = stripHtml(htmlContent);
  const escPos    = buildEscPos(plainText, { paperWidth, autoCut });

  // Repeat for copies
  let content = escPos;
  if (copies === 2) {
    const cutBetween = autoCut ? '' : '\n' + '-'.repeat(paperWidth === 58 ? 32 : 48) + '\n';
    content = escPos + cutBetween + escPos;
  }

  if (isWindows) {
    return printOnWindows(printerName, content, opts);
  } else {
    return printOnCups(printerName, content, opts);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — browser pings this to detect the server
app.get('/health', async (req, res) => {
  const printers = await getPrinters();
  res.json({
    ok:       true,
    version:  VERSION,
    platform: os.platform(),
    printers,
  });
});

// List printers
app.get('/printers', async (req, res) => {
  try {
    const printers = await getPrinters();
    res.json({ printers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Print job
// Body: { printer, content, paperWidth, copies, autoCut }
app.post('/print', async (req, res) => {
  const { printer, content, paperWidth = 80, copies = 1, autoCut = true } = req.body;

  if (!printer) {
    res.status(400).json({ error: 'printer name is required' });
    return;
  }
  if (!content) {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  try {
    await doPrint(printer, content, { paperWidth, copies, autoCut });
    console.log(`[${new Date().toISOString()}] Printed to: ${printer}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Print error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Test print — sends a test page to confirm the printer works
app.post('/print/test', async (req, res) => {
  const { printer, paperWidth = 80 } = req.body;

  if (!printer) {
    res.status(400).json({ error: 'printer name is required' });
    return;
  }

  const lineWidth = paperWidth === 58 ? 32 : 48;
  const testContent = `
<div>
  <div style="text-align:center">
    <p><strong>SWIFTPOS TEST PAGE</strong></p>
    <p>Print server v${VERSION}</p>
  </div>
  <p>---</p>
  <p>Printer: ${printer}</p>
  <p>Paper: ${paperWidth}mm</p>
  <p>Platform: ${os.platform()}</p>
  <p>Time: ${new Date().toLocaleString()}</p>
  <p>---</p>
  <div style="text-align:center">
    <p>If you can read this, printing is working correctly.</p>
  </div>
</div>`;

  try {
    await doPrint(printer, testContent, { paperWidth, copies: 1, autoCut: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = http.createServer(app);

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════╗');
  console.log('  ║       SwiftPOS Print Server            ║');
  console.log(`  ║       Version ${VERSION}                    ║`);
  console.log('  ╚════════════════════════════════════════╝');
  console.log('');
  console.log(`  Listening on: http://localhost:${PORT}`);
  console.log(`  Platform:     ${os.platform()}`);
  console.log('');
  console.log('  Keep this window open while using SwiftPOS.');
  console.log('  The dashboard will detect it automatically.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: Port ${PORT} is already in use.`);
    console.error('  Another instance of SwiftPOS Print Server may already be running.\n');
  } else {
    console.error('\n  ERROR:', err.message, '\n');
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT',  () => { console.log('\n  Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n  Shutting down...'); process.exit(0); });
