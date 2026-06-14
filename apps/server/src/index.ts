import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors        from 'cors';
import helmet      from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import apiRoutes   from './routes';
import { startDailySummaryJob } from './jobs/dailySummary';
import { startEtimsRetryJob }   from './jobs/etimsRetry';

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
  keyGenerator: (req) => ipKeyGenerator(req), // handles IPv4-mapped IPv6 correctly
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
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'swiftpos-server', env: ENV, ts: new Date().toISOString() });
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
  startDailySummaryJob();
  startEtimsRetryJob();
});
