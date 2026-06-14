import { safeRouter } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/auth";
import { supabase } from "../lib/supabase";

const router = safeRouter();
router.use(requireAuth);

// GET /api/notifications?unread=true&limit=20
// Returns notifications for the business, optionally filtered to unread only.
router.get("/", async (req, res) => {
  const unreadOnly = req.query.unread === "true";
  const limit = Math.min(50, parseInt(req.query.limit as string) || 20);

  let query = supabase
    .from("notifications")
    .select("id, type, title, message, link, read_at, created_at", {
      count: "exact",
    })
    .eq("business_id", req.businessId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (unreadOnly) query = query.is("read_at", null);

  const { data, error, count } = await query;
  if (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(204).send();
});

export default router;
