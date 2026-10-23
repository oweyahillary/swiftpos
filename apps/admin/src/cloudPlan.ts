/**
 * cloudPlan.ts — A569 (2026-10-22): the client's cloud plan in words on the admin portal.
 *
 * Owner: "they should get a 1 month trial plan for cloud if they have subscribed on the desktop platform". The cloud
 * starts a 30-day trial with the client's first desktop licence (apps/server/src/lib/cloudTrial.ts) and sends it on
 * GET /clients/:id as `cloud_trial` { started_at, ends_at, converted_at, phase } and `plan_label`. The header's "Plan"
 * tile read "None" for every desktop client (no plan rows exist); it now reads Desktop / Cloud trial / Cloud.
 *
 * Pure, so the test runs it.
 */
export type TrialPhase = "active" | "reports_only" | "ended" | "converted";
export interface CloudTrialView { started_at: string; ends_at: string; converted_at: string | null; phase: TrialPhase }
export type Tone = "ok" | "warn" | "bad" | "muted";

/** "22 Nov 2026", in Nairobi time. */
export function trialDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Nairobi" });
}

/** A trial that is not yet paid for (in its 30 days, its week of reports only, or past it). */
export function unpaidTrial(t: CloudTrialView | null | undefined): t is CloudTrialView {
  return !!t && t.phase !== "converted";
}

/** The header's "Web portal" tile. */
export function webPortalTile(trial: CloudTrialView | null | undefined, webHosting: boolean): { text: string; tone: Tone } {
  if (unpaidTrial(trial)) {
    if (trial.phase === "active") return { text: `Cloud trial — ends ${trialDate(trial.ends_at)}`, tone: "warn" };
    if (trial.phase === "reports_only") return { text: `Trial ended ${trialDate(trial.ends_at)} — reports only`, tone: "bad" };
    return { text: `Trial ended ${trialDate(trial.ends_at)}`, tone: "bad" };
  }
  return webHosting ? { text: "Active", tone: "ok" } : { text: "Not enabled", tone: "bad" };
}

/** The header's "Plan" tile: a real subscription when there is one, else the cloud's plan in words. */
export function planTile(activeSub: { expires_at?: string | null; plans?: { name?: string | null } | null } | null | undefined,
  planLabel: string | null | undefined): { text: string; tone: Tone } {
  if (activeSub) return { text: `${activeSub.plans?.name || "Active"} · to ${trialDate(activeSub.expires_at)}`, tone: "ok" };
  const label = planLabel || "Desktop";
  return { text: label, tone: label === "Cloud trial" ? "warn" : label === "Cloud trial ended" ? "bad" : label === "No licence yet" ? "muted" : "ok" };
}

/** Plan & billing: the trial line above "Convert to paid", or null when there is no unpaid trial. A581: converting is the
 *  Cloud plan's Record payment (amount and period editable) — the fixed "KES 10,000, one year" is gone from this button. */
export function trialBillingLine(trial: CloudTrialView | null | undefined): { title: string; text: string } | null {
  if (!unpaidTrial(trial)) return null;
  const end = trialDate(trial.ends_at);
  if (trial.phase === "active") {
    return { title: `Cloud trial — ends ${end}`,
      text: "Started with the first desktop licence; no invoice was raised. Convert to paid = record the first payment on the Cloud plan below (KES 3,000 a month by default, editable); it raises a paid invoice and turns web access on." };
  }
  if (trial.phase === "reports_only") {
    return { title: `Cloud trial ended ${end} — reports only`,
      text: "The owner can still sign in to read reports for 7 days after the trial, then sign-in stops. Tills are not affected. Convert to paid to keep the dashboard." };
  }
  return { title: `Cloud trial ended ${end}`,
    text: "The owner can no longer sign in to the web dashboard (\"Your cloud trial has ended\"). Tills are not affected. Convert to paid to give it back." };
}

/** The client list's plan colour. */
export function planTone(label: string | null | undefined): Tone {
  if (label === "Cloud") return "ok";
  if (label === "Cloud trial") return "warn";
  if (label === "Cloud trial ended") return "bad";
  return "muted";
}

// ── A581 / A584: the cloud payment plan (per business; paid-until = web access expiry) ─────────────────────────────
/** Where a client stands — GET /clients rows' `cloud`, and the Plan & billing card's `standing` (lib/cloudPlan.ts standingView). */
export interface CloudStandingView {
  paid_until: string | null; days_left: number | null; state: string; sync_refused: boolean; trial: boolean;
  sync_stops_at?: string | null; gated?: boolean;
  due_at?: string | null; lock_at?: string | null; unpaid_days?: number | null; lock_in_days?: number | null; locked_days?: number | null;
  bridge_pending?: boolean; web_locked?: boolean;
}
const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/**
 * A584: the client list's billing status (ZapTill's eyes only — the client is never shown a countdown):
 *   "Due in 5 days" / "Due today" / "Paid to 23 Nov 2026" · "Unpaid 3 days (locks in 4 days)" · "Locked 2 days" ·
 *   "No expiry set" · a trial's own words. null: nothing to bill.
 */
export function expiryText(c: CloudStandingView | null | undefined): { text: string; tone: Tone } | null {
  if (!c) return null;
  if (c.state === "no_expiry") return { text: "No expiry set", tone: "warn" };
  if (c.state === "no_date") return { text: "On a plan — no payment yet", tone: "warn" };
  if (c.state === "off") return { text: "Web access off", tone: "muted" };
  if (c.trial) {
    if (c.state === "ended") return { text: "Trial ended — locked", tone: "bad" };
    if (c.state === "locked") return { text: "Trial ended — locked", tone: "bad" };
    if (c.state === "reports_only") return { text: "Trial ended — reports only", tone: "bad" };
    const d = c.days_left ?? 0;
    return { text: d <= 0 ? "Trial ends today" : `Trial — ends in ${dayWord(d)}`, tone: d <= 7 ? "warn" : "ok" };
  }
  if (c.state === "locked") { const n = c.locked_days ?? 0; return { text: n <= 0 ? "Locked today" : `Locked ${dayWord(n)}`, tone: "bad" }; }
  if (c.state === "unpaid") {
    const u = c.unpaid_days ?? 0, m = c.lock_in_days ?? 0;
    const lock = m <= 0 ? "locks tonight" : `locks in ${dayWord(m)}`;
    return { text: u <= 0 ? `Due today (${lock})` : `Unpaid ${dayWord(u)} (${lock})`, tone: u >= 5 ? "bad" : "warn" };
  }
  if (c.days_left === null || c.days_left === undefined || !c.paid_until) return null;
  const d = c.days_left;
  if (d <= 0) return { text: "Due today", tone: "warn" };
  if (d <= 31) return { text: `Due in ${dayWord(d)}`, tone: d <= 7 ? "warn" : "ok" };
  return { text: `Paid to ${trialDate(c.due_at ?? c.paid_until)}`, tone: "ok" };
}

/** The Plan & billing card's headline and explanation. */
export function standingLine(s: CloudStandingView | null | undefined): { title: string; text: string; tone: Tone } {
  if (!s) return { title: "Not on a cloud plan", tone: "muted", text: "Set a plan or record a payment to put this client on it." };
  if (s.state === "no_expiry") return { title: "No expiry set", tone: "warn",
    text: "Web access is on with no paid-until date, so nothing is billed and nothing locks. Record a payment (or a complimentary paid-until) to put this client on the plan." };
  if (s.state === "off") return { title: "Web access off — not billed", tone: "muted",
    text: "Web access was switched off and the client is not on a plan: no invoice goes out. Record a payment to turn it on." };
  if (!s.gated) return { title: "Not on a cloud plan", tone: "muted",
    text: "No web access. Record a payment (or a complimentary paid-until) to turn it on and put this client on the plan." };
  if (!s.paid_until) return { title: "On a plan — no payment yet", tone: "warn", text: "Record the first payment to set the paid-until date." };
  const due = trialDate(s.due_at ?? s.paid_until);
  const lastOpen = s.lock_at ? trialDate(new Date(Date.parse(s.lock_at) - 1).toISOString()) : "—";
  if (s.trial) {
    if (s.sync_refused) return { title: s.state === "locked" || s.state === "ended" ? "Trial ended — locked" : "Trial ended — reports only", tone: "bad",
      text: "Sync is stopped and no till can be joined; the tills keep selling. Recording a payment converts the trial and opens everything at once." };
    return { title: `Cloud trial — ends ${due}`, tone: (s.days_left ?? 0) <= 7 ? "warn" : "ok",
      text: "No invoice for a trial. After it ends: 7 days of reports only, then locked. Recording a payment converts it." };
  }
  if (s.state === "locked") return { title: `Locked — unpaid since ${due}`, tone: "bad",
    text: "The web dashboard is paused (\"Your ZapTill cloud access is paused. Call 0717 675 635 to renew.\"), the cloud refuses this client's tills' sync and no till can be joined. The tills keep selling and keep their sales; recording a payment opens everything at once and the queue drains." };
  if (s.state === "unpaid") {
    const u = s.unpaid_days ?? 0, m = s.lock_in_days ?? 0;
    return { title: `${u <= 0 ? "Due today" : `Unpaid ${dayWord(u)}`} — locks ${m <= 0 ? "tonight" : `in ${dayWord(m)}`} (end of ${lastOpen})`, tone: u >= 5 ? "bad" : "warn",
      text: `The invoice went to the client on ${due}. Everything works until the end of ${lastOpen}; then it locks at once — the client is not warned. A payment now covers the invoiced period (from ${due}).${s.bridge_pending ? " (Its plan row is made by the next billing pass.)" : ""}` };
  }
  const d = s.days_left ?? 0;
  return { title: `Paid until ${due} — ${d <= 0 ? "due today" : `${dayWord(d)} left`}`, tone: d <= 7 ? "warn" : "ok",
    text: `On ${due} an invoice goes to the client by email (the next period). Unpaid 7 days after that, it locks at the end of ${lastOpen}. You get the invoice copy, a note on day 5, and the lock.` };
}

/** The notice milestone in words (A584's admin notices; A581's client reminders as history). */
export function milestoneText(m: string): string {
  if (m === "invoice") return "invoice sent";
  if (m === "unpaid_5") return "unpaid 5 days (to ZapTill)";
  if (m === "locked") return "locked (to ZapTill)";
  if (m === "trial_end") return "trial ended (to ZapTill)";
  if (m.startsWith("before_")) return `${m.slice(7)} day${m.slice(7) === "1" ? "" : "s"} before`;
  if (m === "lapse_day") return "the day it lapsed";
  const w = Number(m.replace("lapsed_w", ""));
  return `lapsed ${w} week${w === 1 ? "" : "s"}`;
}

/** The default amount for a period at a monthly price (no discount for paying ahead); "" for a custom end date. */
export function periodDefault(period: string, monthly = 3000): string {
  const months = ({ monthly: 1, "3_months": 3, "6_months": 6, "12_months": 12 } as Record<string, number>)[period];
  return months ? String(monthly * months) : "";
}
