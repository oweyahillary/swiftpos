import 'dotenv/config';
// Must stay directly below dotenv and ABOVE './routes' — see lib/envGuard.ts.
// It reports every missing variable at once instead of letting the first module
// that needs one throw a single-line stack trace (audit H10).
import './lib/envGuard';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors        from 'cors';
import helmet      from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import apiRoutes   from './routes';
import { supabase } from './lib/supabase';
import { checkSchema, schemaAdvice } from './lib/schemaCheck';
import { startDailySummaryJob } from './jobs/dailySummary';
import { startEtimsRetryJob }   from './jobs/etimsRetry';
import { reportSeededAdmins }   from './lib/adminSeedGuard';

const app  = express();
const PORT = process.env.PORT ?? 4000;
const ENV  = process.env.NODE_ENV ?? 'development';
const isProd = ENV === 'production';

// ── Structured logging ────────────────────────────────────────────────────────
// Thin wrapper — swap for pino/winston when log aggregation is needed.
export const log = {
  info:  (msg: string, meta?: object) => console.log(JSON.stringify({ level: 'info',  msg, ...meta, ts: new Date().toISOString() })),
  warn:  (msg: string, meta?: object) => console.warn(JSON.stringify({ level: 'warn',  msg, ...meta, ts: new Date().toISOString() })),
  error: (msg: string, meta?: object) => console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: new Date().toISOString() })),
};

// ── Trust proxy (required when behind nginx / Render / Railway) ───────────────
// Without this, express-rate-limit sees the load-balancer IP for everyone
// instead of the real client IP, making rate limiting per-IP useless.
if (isProd) app.set('trust proxy', 1);

// ── Security headers (helmet) ─────────────────────────────────────────────────
// Adds: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection,
//       Strict-Transport-Security, Referrer-Policy, Permissions-Policy,
//       and a restrictive Content-Security-Policy by default.
//
// crossOriginResourcePolicy: 'cross-origin' lets the dashboard fetch assets
// (product images) from the same server without CORP blocks.
app.use(helmet({
  crossOriginResourcePolicy:  { policy: 'cross-origin' },
  crossOriginOpenerPolicy:    { policy: 'same-origin-allow-popups' }, // needed for Supabase OAuth if ever used
  contentSecurityPolicy: isProd ? undefined : false, // disable CSP in dev (Vite HMR)
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
// Set CORS_ORIGINS as a comma-separated list in .env:
//   CORS_ORIGINS=https://app.swiftpos.co.ke,http://localhost:5173
const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4173,http://localhost:5174')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Electron / curl / server-to-server
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' })); // explicit limit — prevents oversized payload DoS

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Auth: tight — brute-force protection on login + verify-pin
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts — please try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''), // handles IPv4-mapped IPv6 correctly
});

// General API: generous — safety net against runaway clients / scrapers
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests — please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth',       authLimiter);
app.use('/api/admin/auth', authLimiter); // brute-force on admin login
app.use('/api',            apiLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
// Does a lightweight DB round-trip so an external uptime pinger hitting this
// endpoint keeps BOTH Render (spins down after ~15min idle) and Supabase
// (pauses after ~7 days idle) warm. HEAD request (head: true) returns no rows —
// just enough to reach Postgres. Bounded by a timeout so the check never hangs.
app.get('/health', async (_req, res) => {
  const started = Date.now();

  const ping = supabase
    .from('businesses')
    .select('id', { head: true, count: 'exact' })
    .limit(1);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('health db timeout')), 5000),
  );

  try {
    const { error } = (await Promise.race([ping, timeout])) as Awaited<typeof ping>;
    if (error) throw error;

    const schema = await checkSchema();

    const body: Record<string, unknown> = {
      status: schema.ok ? 'ok' : 'degraded',
      service: 'swiftpos-server',
      db: 'up',
      // Whether the database actually has the columns this build writes.
      // "up" only ever meant reachable — three unapplied migrations once left
      // every order failing on push while this endpoint reported ok.
      schema: schema.ok ? 'ok' : 'drift',
      latencyMs: Date.now() - started,
      ts: new Date().toISOString(),
    };
    if (!schema.ok) {
      body.missing = schema.missing;
      body.advice  = schemaAdvice(schema);
      log.warn('Schema drift detected', { missing: schema.missing });
    }
    // Only expose version + env outside production to avoid fingerprinting.
    if (!isProd) {
      body.version = '1.0.0';
      body.env     = ENV;
    }
    res.json(body);
  } catch (err) {
    log.warn('Health check DB ping failed', { message: (err as Error).message });
    res.status(503).json({
      status: 'degraded',
      service: 'swiftpos-server',
      db: 'down',
      ts: new Date().toISOString(),
    });
  }
});

// GET /health/schema — strict. 503 when the database is missing columns this
// build writes.
//
// Kept separate from /health because render.yaml points healthCheckPath at
// /health: returning 503 there would take the whole service down for a problem
// that may only affect some routes, turning a bad deploy into an outage. This
// endpoint is for people and deploy scripts to ask deliberately, and it is
// meant to be the last step of DEPLOY_AND_TEST §1:
//
//     curl -sf $API/health/schema || echo "MIGRATIONS NOT APPLIED"
app.get('/health/schema', async (_req, res) => {
  const schema = await checkSchema();
  res.status(schema.ok ? 200 : 503).json({
    status:  schema.ok ? 'ok' : 'drift',
    missing: schema.missing,
    ...(schema.error ? { error: schema.error } : {}),
    ...(schema.ok ? {} : { advice: schemaAdvice(schema) }),
    ts: new Date().toISOString(),
  });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── Global error handler ──────────────────────────────────────────────────────
// Last-resort catch for anything thrown/passed to next(err).
// Returns consistent { error: string } — never leaks stack traces.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error('Unhandled route error', { message: err.message, stack: isProd ? undefined : err.stack });

  // express.json() throws this when body exceeds the limit
  if ((err as any).type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload too large (max 1MB)' });
    return;
  }

  if (err.message.startsWith('CORS:')) {
    res.status(403).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log.info('Server started', { port: PORT, env: ENV, origins: allowedOrigins });

  // Audit C4 diagnostic. Deliberately not awaited and never throws — login
  // already refuses the seed credential outright, so this exists to make the
  // problem visible in the log rather than to gate anything. A shop's tills must
  // not fail to start over an admin-portal seed.
  void reportSeededAdmins();
  startDailySummaryJob();
  startEtimsRetryJob();
});
