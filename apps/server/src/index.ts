import 'dotenv/config';
// Must stay directly below dotenv and ABOVE './routes' — see lib/envGuard.ts.
// It reports every missing variable at once instead of letting the first module
// that needs one throw a single-line stack trace (audit H10).
import './lib/envGuard';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors        from 'cors';
import { apiHelmet } from './lib/apiHeaders';     // A528
import { countTraffic } from './lib/trafficStats'; // A528
import { signAnswers } from './lib/serverSignature'; // A529
import { compressJson } from './lib/compressJson';    // A531
import { labelRequests } from './lib/supabaseMeter';  // A591
import { trackWrites } from './lib/writeActivity';    // A591
import { attachLiveHub, startSyncChangePruneJob } from './lib/liveHub'; // A531
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import apiRoutes   from './routes';
import { supabase } from './lib/supabase';
import { checkSchema, schemaAdvice } from './lib/schemaCheck';
import { startDailySummaryJob } from './jobs/dailySummary';
import { reportMailReadiness }  from './lib/mailer';
import { startEtimsRetryJob }   from './jobs/etimsRetry';
import { startWatchdogJob }     from './jobs/watchdog';          // A383
import { startMonthlyPackJob }  from './jobs/monthlyPack';       // A455
import { startOwnerAlertsJob }  from './jobs/ownerAlerts';       // A476
import { startLossAlertsJob }   from './jobs/lossAlerts';        // A576
import { startCloudPlanRemindersJob } from './jobs/cloudPlanReminders';   // A581
import { recordServerError, recordFailedSignIn, isSignInFailure, isTillSync, recordSyncAttempt, recordSyncQueue, parseQueueCount, recordRequestDuration } from './lib/watchdogCounters';
import { reportSeededAdmins }   from './lib/adminSeedGuard';
import { ensurePermissionsRegistered } from './lib/permissionCatalogue';
import { refreshPermissionsState } from './lib/permissionsState';   // A490
import { buildInfo, recordBoot } from './lib/opsEvents';   // A525: what this server runs; its start recorded
import { isTenantOrigin }       from './lib/tenantHost';   // A378: clients' own sign-in addresses
import { isRenewalPath, renewalKey, RENEWALS_PER_WINDOW } from './lib/authLimits';   // A415
import { authLimiterKeyFor, apiLimiterKeyFor, BUCKET_VERIFY_OPTIONS } from './lib/limiterKeys';   // A494, A505
import jwt from 'jsonwebtoken';
import { backfillBodyParser, BACKFILL_JSON_LIMIT } from './lib/backfill';   // A602

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

// A529: FIRST — every answer says it is this server's (lib/serverSignature.ts), whatever answers it: a route, an unknown
// route's 404, the error handler, the rate limiter's 429, /health. A till treats an answer without it as no connection
// (a suspended Render service, a Cloudflare page, a captive portal), never as the cloud's verdict.
app.use(signAnswers);

// ── Trust proxy (required when behind nginx / Render / Railway) ───────────────
// Without this, express-rate-limit sees the load-balancer IP for everyone
// instead of the real client IP, making rate limiting per-IP useless.
if (isProd) app.set('trust proxy', 1);

// ── Security headers (helmet) ─────────────────────────────────────────────────
// Adds: X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, Referrer-Policy.
//
// crossOriginResourcePolicy: 'cross-origin' lets the dashboard fetch assets
// (product images) from the same server without CORP blocks.
// A528: only the headers that mean something on a JSON answer (lib/apiHeaders.ts) — this server serves no HTML page, and
// helmet's document headers (CSP, COOP, …) added ~1.2 KB to every answer every till polls every 20 s.
app.use(apiHelmet());

// A528: requests and bytes per route family since start — the admin portal's System page (lib/trafficStats.ts).
app.use(countTraffic);

// A531: a JSON answer over 1 KB is gzip-compressed for a client that accepts it (a till's fetch does), with its real
// length — so the traffic counter above still counts the bytes actually sent (lib/compressJson.ts).
app.use(compressJson);

// ── CORS ──────────────────────────────────────────────────────────────────────
// Set CORS_ORIGINS as a comma-separated list in .env:
//   CORS_ORIGINS=https://app.zaptill.co.ke,http://localhost:5173
const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4173,http://localhost:5174')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Electron / curl / server-to-server
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // A378: a client's own sign-in address (https://africanfries.<TENANT_ROOT_DOMAIN>) and the root's other https
    // addresses — one label deep, https only (shared/tenantHost.ts). Off while TENANT_ROOT_DOMAIN is unset.
    if (isTenantOrigin(origin, process.env.TENANT_ROOT_DOMAIN)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));

// A602: the POS's sales history in bulk (gzip'd, up to 500 sales a call) has its own, larger limit — on the INFLATED size.
// Mounted first: the 1 MB parser below then sees a body already read and leaves it alone.
app.use('/api/sync/backfill', backfillBodyParser);
app.use(express.json({ limit: '1mb' })); // explicit limit — prevents oversized payload DoS

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Auth: tight — brute-force protection on login + verify-pin
// Keying by raw IP treated an entire BRANCH as one attacker: every till and
// the office dashboard NAT through one address, so two tills shared 20 PIN
// attempts per 15 minutes and the pad showed "Too many requests" during
// normal service. Key by the device (header set by the till) or the session
// token when present; the shared IP is only the key for anonymous traffic —
// which is exactly the traffic brute-force limits exist for.
// KEY STRATEGY — two different jobs, two different keys.
//
// The GENERAL API limiter is a fairness safety net: two tills behind one office
// NAT must not share a quota, so it keys by device (header set by the till) or
// session token, falling back to IP for anonymous traffic.
//
// The AUTH limiter is BRUTE-FORCE protection, and its threat model is an
// ANONYMOUS attacker — who controls the x-device-id header and can set a fresh
// value on every request, sailing straight past a device-keyed limit. So the
// auth limiter must key on something the attacker cannot freely rotate: the
// source IP. A determined attacker can change IP too, but that is far more
// costly than editing a header, and IP-keyed limiting is the standard control.
// (Finding #12: keying auth attempts on the client-supplied device header meant
// the PIN brute-force limit never actually fired.)
// A494 (lib/limiterKeys.ts): a header the caller made up never picks a bucket. The anonymous sign-in paths are keyed on
// the address ONLY; anywhere else a Bearer token picks the bucket only once it VERIFIES (the till's own session by its
// device, a person's by their sign-in session); x-device-id is not read at all — any string a caller liked used to be a
// fresh 600/minute (and, on the auth paths, a fresh 30 failures).
// A505: the signature picks the bucket, not the expiry — a till's expired 15-minute token is still its own bucket, not the
// shop's shared address (lib/limiterKeys.ts BUCKET_VERIFY_OPTIONS).
const verifyOurs = (token: string) => jwt.verify(token, process.env.JWT_SECRET ?? '', BUCKET_VERIFY_OPTIONS);
const limiterInput = (req: import('express').Request) => ({
  url: req.originalUrl || req.url || '',
  authorization: req.header('authorization') ?? null,
  ipKey: ipKeyGenerator(req.ip ?? ''),
});
const limiterKey = (req: import('express').Request): string => apiLimiterKeyFor(limiterInput(req), verifyOurs);
const authLimiterKey = (req: import('express').Request): string => authLimiterKeyFor(limiterInput(req), verifyOurs);

// A415 (lib/authLimits.ts): only FAILED attempts count, and a till's renewals are not counted here at all — a till
// retrying a refused renewal used to use up the shop's 30 and lock the owner out of the web sign-in on the first try.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many attempts — please try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authLimiterKey,
  skipSuccessfulRequests: true,
  skip: (req) => isRenewalPath(req.path),
});

// A415: the renewals' own counter, per till.
const renewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RENEWALS_PER_WINDOW,
  message: { error: 'Too many renewals from this POS — it tries again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => renewalKey(req.header('x-device-id') ?? (typeof req.body?.device_id === 'string' ? req.body.device_id : ''), ipKeyGenerator(req.ip ?? '')),
  skip: (req) => !isRenewalPath(req.path),
});

// General API: generous — safety net against runaway clients / scrapers.
// Per device/session, so one busy till never starves its neighbour.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { error: 'Too many requests — please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
});

// A383: the watchdog counts what the database cannot tell it — server errors (a burst alerts the admin) and
// refused sign-ins (the morning digest). After the response is sent; never changes it.
// A392: and per account (repeated failed sign-ins alert at once), and what each till's push was answered (a till the
// cloud keeps refusing — licence, branch, device revoked, rows refused — alerts at once).
app.use((req, res, next) => {
  const path0 = req.originalUrl || req.url || '';
  const tillSync = isTillSync(req.method, path0) && !!req.header('X-Device-Id');
  let answer: any = null;
  const startedAt = Date.now();   // A589: the answer time — the overload signal (lib/watchdogRules.ts serverOverload)
  if (tillSync) {
    const json = res.json.bind(res);
    res.json = ((body: any) => { answer = body; return json(body); }) as typeof res.json;
  }
  res.on('finish', () => {
    const path = path0;
    // A581: a lapsed cloud plan's 503 (CLOUD_SUBSCRIPTION_ENDED) is a decision, not a fault — never a server error, never a
    // till "the cloud keeps refusing" (the admin is told by the plan's reminders and the client list).
    if (res.locals.cloudLapsed === true) return;
    // A589: a stream or a file download takes as long as it takes — not a slow server.
    const type = String(res.getHeader('content-type') ?? '');
    if (!/event-stream|octet-stream|application\/x-msdownload/i.test(type)) recordRequestDuration(Date.now() - startedAt);
    if (res.statusCode >= 500) recordServerError(path);
    else if (isSignInFailure(req.method, path, res.statusCode)) {
      recordFailedSignIn({ path, account: typeof req.body?.email === 'string' ? req.body.email : '', ip: req.ip ?? '' });
    }
    if (tillSync) {
      const rejected = Array.isArray(answer?.rejected) ? answer.rejected : [];
      recordSyncAttempt({
        deviceId: String(req.header('X-Device-Id')), businessId: (req as any).businessId ?? null,
        ok: res.statusCode < 400, status: res.statusCode,
        code: typeof answer?.code === 'string' ? answer.code : (rejected[0]?.code ?? null),
        error: typeof answer?.error === 'string' ? answer.error : (rejected[0]?.error ?? null),
        rejected: rejected.length,
      });
      // A579: a 1.0.20 till says what it still has to send (its idle heartbeat included) — only a push the cloud took.
      if (res.statusCode < 400 && /^\/api\/sync\/push\/?$/.test(path.split('?')[0])) {
        recordSyncQueue(String(req.header('X-Device-Id')), parseQueueCount(req.header('X-Sync-Pending')), parseQueueCount(req.header('X-Sync-Failed')));
      }
    }
  });
  next();
});

// A591: every Supabase call is counted against the route that made it (lib/supabaseMeter.ts — the System page's Supabase
// card), and every write a client makes moves its business's write generation (lib/writeActivity.ts — the polled answers
// remembered while nothing was written). After the body parser: a request's work runs inside its label from here on.
app.use(labelRequests);
app.use(trackWrites());

app.use('/api/auth',       authLimiter);
app.use('/api/auth',       renewLimiter);   // A415
app.use('/api/admin/auth', authLimiter); // brute-force on admin login
app.use('/api',            apiLimiter);

// A500: the till's connection test asks /api/health through its branch server's gateway, which forwards /api/* only —
// so it always got a 404 (counted as "ok", but logged as "connection test: HTTP 404" on every till). A plain answer, no
// database round-trip: it says the cloud is reachable, nothing more.
app.get('/api/health', (_req, res) => { res.json({ ok: true }); });

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
      // A525: what this server runs — the GitHub deploy check (verify-prod-deploy.yml) compares it with the newest server
      // change on main. 1.0.16 to 1.0.18 never reached production and /health could not say so.
      ...buildInfo(),
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
      ...buildInfo(),   // A525: a server with its database down still says what it runs
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
    res.status(413).json({ error: `Payload too large (max ${/^\/api\/sync\/backfill/.test(_req.originalUrl ?? '') ? BACKFILL_JSON_LIMIT.toUpperCase() : '1MB'})`, code: 'PAYLOAD_TOO_LARGE' });
    return;
  }

  if (err.message.startsWith('CORS:')) {
    res.status(403).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  log.info('Server started', { port: PORT, env: ENV, origins: allowedOrigins });

  // Audit C4 diagnostic. Deliberately not awaited and never throws — login
  // already refuses the seed credential outright, so this exists to make the
  // problem visible in the log rather than to gate anything. A shop's tills must
  // not fail to start over an admin-portal seed.
  void reportSeededAdmins();

  // A213: self-heal the permissions catalogue. A consolidated-dump bootstrap can
  // leave the live catalogue missing keys (the A211/A212/A220 root), which
  // silently hides nav items and blocks role grants. This idempotently registers
  // every canonical key (DO NOTHING on conflict) so no DB can drift missing one.
  // Not awaited and never throws — startup must not depend on it.
  void ensurePermissionsRegistered();
  void refreshPermissionsState();   // A490: has migration 134 rewritten the grants into fine keys?

  // Same shape and the same reason: make a broken mail path visible at boot
  // instead of at 18:00 UTC in a log nobody reads. Nine businesses got no daily
  // summary for as long as anyone has been looking (A50). Never awaited, never
  // throws — a shop must not fail to trade over an unverified mail domain.
  void reportMailReadiness();

  // A591: BACKGROUND_JOBS=off (the DEV service on Render) starts none of the scheduled jobs — every one reads Supabase
  // around the clock, and the dev project's egress counts against the same Free-plan organisation as production.
  if (String(process.env.BACKGROUND_JOBS ?? '').toLowerCase() === 'off') {
    console.log('[jobs] BACKGROUND_JOBS=off — no scheduled jobs on this server (summaries, watchdog, alerts, billing)');
  } else {
    startDailySummaryJob();
    startEtimsRetryJob();
    startWatchdogJob();
    startMonthlyPackJob();   // A455: the monthly pack by email on the 1st
    startOwnerAlertsJob();   // A476: branch managers' open tills (always), the owner's alerts, the weekly summary
    startLossAlertsJob();    // A576: loss-prevention alerts every hour (the watch list, the bell)
    startCloudPlanRemindersJob();   // A581: cloud plan reminders to the owner and ZapTill (14/7/3/1 days, lapse, weekly)
  }

  // A525: the start, in the admin portal's System page (public.ops_events). Never awaited, never throws — a missing
  // table (migration 149 not run) is a warning in the log.
  void recordBoot();

  // A531: old change-log entries go once a day (30 days kept; a till further behind takes the whole menu once).
  startSyncChangePruneJob();
});

// A531: the push channel — /api/pos/live (a WebSocket on the same port). A till (or a branch server) holds one; the cloud
// says "changed" the moment a change it needs is written, and the till asks GET /api/pos/changes for just those rows.
attachLiveHub(httpServer);
