import { safeRouter } from "../middleware/asyncHandler";
import { sendError } from '../lib/sendError';
import { requireAuth } from "../middleware/auth";
import { supabase } from "../lib/supabase";
import { sendEmailChecked } from "../lib/mailer";

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
    .select("id, type, title, message, link, read_at, created_at, branch_id", {
      count: "exact",
    })
    .eq("business_id", req.businessId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (unreadOnly) query = query.is("read_at", null);
  if (branch) query = query.eq("branch_id", branch);
  if (types.length) query = query.in("type", types);

  const { data, error, count } = await query;
  if (error) {
    sendError(res, error);
    return;
  }

  res.json({ notifications: data ?? [], unreadCount: count ?? 0 });
});

// PATCH /api/notifications/:id/read
// Mark a single notification as read.
router.patch("/:id/read", async (req, res) => {
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
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("business_id", req.businessId)
    .is("read_at", null);

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
    subject: "SwiftPOS test email",
    html:
      "<p>This is a SwiftPOS test email.</p>" +
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
