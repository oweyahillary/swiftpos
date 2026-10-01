import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';
import { RELEASE } from '../lib/release';
import { REQUIRED_DESKTOP_SCHEMA } from '../lib/desktopSchema';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/version — which release of the cloud is running (owner, 2026-10-01: "add versioning on the website also so
// that i can tell which one i am running"). The dashboard and the web POS show it beside their own and say when the two
// differ (the cloud deployed, the website not yet — or the other way round). Signed-in only: /health keeps the version
// out of production for anonymous callers (no fingerprinting), and this keeps that rule.
//
// `commit` is the commit Render built (RENDER_GIT_COMMIT, set by Render on every deploy); null elsewhere.
// ─────────────────────────────────────────────────────────────────────────────
const router = safeRouter();

const body = () => ({
  release: RELEASE,
  commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
  desktopSchema: REQUIRED_DESKTOP_SCHEMA,
});

router.get('/', requireAuth, (_req, res) => { res.json(body()); });
export default router;

// GET /api/admin/version — the same, for the admin portal (it signs in with its own token, under /api/admin).
export const adminVersionRouter = safeRouter();
adminVersionRouter.get('/', requireAdmin, (_req, res) => { res.json(body()); });
