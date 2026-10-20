// GET /api/pos/branch-drawers?since=<iso> — A535: every drawer of the branch, for its branch server, in one call
// (lib/branchDrawers.ts). Owner, 2026-10-19: "for a setup like KRUNCH only the server does the communication to cloud,
// not all tills". Mounted at /pos/branch-drawers before /pos (routes/index.ts). A cloud before A535 answers 404 here (its
// own signed answer) and the tills keep asking about their drawers themselves, as before.
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { traffic } from '../lib/trafficStats';
import { branchDrawersAnswer, serverBranch } from '../lib/branchDrawers';

const router = safeRouter();
router.use(requireAuth);

router.get('/', async (req, res) => {
  traffic.count('branch_drawers.answered');
  const who = await serverBranch({ businessId: req.businessId!, deviceId: req.deviceId ?? null, isTill: !!req.isTill, surface: req.surface ?? null });
  if ('status' in who) { res.status(who.status).json({ error: who.error, code: who.code }); return; }
  try {
    const answer = await branchDrawersAnswer(req.businessId!, who.branchId, req.query.since);
    res.set('Cache-Control', 'no-store');
    res.json(answer);
  } catch (e) {
    console.warn(`[branch-drawers] ${(e as Error)?.message ?? e}`);
    res.status(503).json({ error: 'The drawers could not be read right now - the branch server asks again shortly.', code: 'DRAWERS_BUSY' });
  }
});

export default router;
