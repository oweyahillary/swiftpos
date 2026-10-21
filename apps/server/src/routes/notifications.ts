import { safeRouter } from "../middleware/asyncHandler";
import { sendError } from '../lib/sendError';
import { requireAuth } from "../middleware/auth";
import { supabase } from "../lib/supabase";
import { sendEmailChecked } from "../lib/mailer";
import { branchScope } from "../middleware/rbac";

/**
 * A494: what a non-owner may see and mark — their branch's notifications that are addressed to nobody in particular or
 * to them. A row addressed to the owner (a change to approve, an M-Pesa number changed, …) or to another person is never
 * theirs, nor another branch's. The owner sees everything, as before (narrowed only by an explicit ?branch).
 */
function forCaller(req: any, q: any): any {
  if (req.isOwner) return q;
  const me = req.userId ? String(req.userId) : null;
  // A550: a partner of every branch reads every branch's (or the one picked) — still only rows addressed to nobody or to
  // them, never the owner's own.
  const scope = branchScope(req);
  if (!(req.allBranches && scope === null)) q = q.eq("branch_id", scope);
  return me ? q.or(`user_id.is.null,user_id.eq.${me}`) : q.is("user_id", null);
}
const mayRead = (req: any, row: { branch_id?: string | null; user_id?: string | null }): boolean => {
  if (req.isOwner) return true;
  const scope = branchScope(req);
  const inScope = req.allBranches && scope === null
    ? (row.branch_id == null || (req.partnerBranches ?? []).includes(row.branch_id))
    : row.branch_id === scope;
  return inScope && (row.user_id == null || row.user_id === req.userId);
};

const router = safeRouter();
router.use(requireAuth);

// GET /api/notifications?unread=true&limit=20&branch=<uuid>&type=a,b
// Returns notifications for the business, optionally filtered to unread only,
// to a single branch, and/or to one or more comma-separated types. branch and
// type let a branch-scoped manager dashboard pull just its own stock alerts
// (register A74); with neither, an owner sees everything as before.
router.get("/", async (req, res) => {
  const unreadOnly = req.query.unread === "true";
  const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
  const branch = typeof req.query.branch === "string" ? req.query.branch.trim() : "";
  const types = typeof req.query.type === "string"
    ? req.query.type.split(",").map(t => t.trim()).filter(Boolean)
    : [];

  let query = supabase
    .from("notifications")
    .select("id, type, title, message, link, read_at, created_at, branch_id, user_id", {
      count: "exact",
    })
    .eq("business_id", req.businessId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (unreadOnly) query = query.is("read_at", null);
  // A494: a non-owner is held to their own branch whatever ?branch says (forCaller); the owner may narrow by it.
  if (branch && req.isOwner) query = query.eq("branch_id", branch);
  if (types.length) query = query.in("type", types);
  query = forCaller(req, query);

  const { data, error, count } = await query;
  if (error) {
    sendError(res, error);
    return;
  }

  // Belt and braces: the same rule over the rows (the query already holds it).
  const rows = ((data ?? []) as any[]).filter((r) => mayRead(req, r)).map(({ user_id: _u, ...r }) => r);
  res.json({ notifications: rows, unreadCount: count ?? 0 });
});

// PATCH /api/notifications/:id/read
// Mark a single notification as read.
router.patch("/:id/read", async (req, res) => {
  // A494: a non-owner marks only a notification that is theirs to read (mayRead) — never the owner's or another's.
  if (!req.isOwner) {
    const { data: row, error: rErr } = await supabase.from("notifications").select("id, branch_id, user_id")
      .eq("id", req.params.id).eq("business_id", req.businessId).maybeSingle();
    if (rErr) { sendError(res, rErr); return; }
    if (!row || !mayRead(req, row as any)) { res.status(404).json({ error: "Notification not found" }); return; }
  }
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("business_id", req.businessId)
    .is("read_at", null);

  if (error) {
    sendError(res, error);
    return;
  }
  res.status(204).send();
});

// PATCH /api/notifications/read-all
// Mark all unread notifications as read for this business.
router.patch("/read-all", async (req, res) => {
  // A494: a non-owner marks only their own (forCaller) — it marked the whole business's, the owner's included, as read.
  const { error } = await forCaller(req, supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("business_id", req.businessId)
    .is("read_at", null));

  if (error) {
    sendError(res, error);
    return;
  }
  res.status(204).send();
});

// POST /api/notifications/test-email — owner-only.
// Sends ONE real message to the owner's OWN address to prove notification
// delivery end to end (register A54). Delivery to self only — there is no
// user-supplied recipient, so this cannot be used to send mail to anyone else.
// Returns the provider that delivered it, or the exact provider error, so the
// owner can confirm mail is live without reading the server boot log.
router.post("/test-email", async (req, res) => {
  if (!req.isOwner) {
    res.status(403).json({ error: "Owner only." });
    return;
  }

  const { data: me, error: meErr } = await supabase
    .from("users")
    .select("email")
    .eq("id", req.userId)
    .maybeSingle();
  if (meErr) {
    sendError(res, meErr);
    return;
  }

  const to = ((me as any)?.email ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    res
      .status(400)
      .json({ error: "Your account has no valid email address to send the test to." });
    return;
  }

  const result = await sendEmailChecked({
    to,
    subject: "ZapTill test email",
    html:
      "<p>This is a ZapTill test email.</p>" +
      "<p>If you are reading this, notification delivery is working.</p>" +
      `<p style="color:#888">Sent ${new Date().toISOString()}</p>`,
  });

  if (result.ok) {
    res.json({ ok: true, provider: result.provider, to });
  } else {
    // A200: the mailer's diagnostic (SMTP ports, Render plan, "CHECK THE LIVE
    // INSTANCE TYPE…") is internal hosting detail and must NOT reach the UI.
    // Log the full diagnostic server-side; return a clean, generic message.
    console.error('[test-email] delivery failed:', { provider: result.provider, to, diagnostic: result.error });
    res.status(502).json({
      ok: false,
      provider: result.provider,
      to,
      error: 'Test email could not be sent — email delivery is not configured or the mail provider is unreachable. See the server logs for details.',
    });
  }
});

export default router;
