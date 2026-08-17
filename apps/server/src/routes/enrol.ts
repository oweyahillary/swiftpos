/**
 * enrol.ts — device-enrolment issuance (register D4; A69 moved it to admin).
 *
 * Issuance USED to live here: the owner, signed into the portal, minted a
 * single-use code for their business. A69 moved that to the SwiftPOS admin
 * portal so a client cannot self-provision a till — provisioning is a billable
 * act under admin control (POST /api/admin/clients/:id/branches/:branchId/
 * enrol-code). The redeem path (POST /api/auth/enrol/redeem, in auth.ts) is
 * unchanged; only issuance moved.
 *
 * This route is kept as an explicit 410 rather than removed, so any caller of the
 * old owner path is told where issuance went instead of hitting a silent 404.
 */
import { requireAuth } from '../middleware/auth';
import { safeRouter } from '../middleware/asyncHandler';

const router = safeRouter();
router.use(requireAuth);

// POST /api/enrol/code — RETIRED (register A69). Issuance moved to the admin portal.
router.post('/code', async (_req: any, res) => {
  res.status(410).json({
    error: 'Enrolment codes are now issued from the SwiftPOS admin portal, not here.',
    code:  'ENROL_ISSUE_MOVED',
  });
});

export default router;
