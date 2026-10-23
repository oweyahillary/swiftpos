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
      text: "Started with the first desktop licence; no invoice was raised. Convert to paid = record the first payment on the Cloud plan below (KES 3,000 a month by default, editable); it raises a paid invoice." };
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

// ── A581: the cloud payment plan (per business; paid-until = web access expiry) ─────────────────────────────────────
/** Where a client on the plan stands — GET /clients rows' `cloud`, and the Plan & billing card's `standing`. */
export interface CloudStandingView {
  paid_until: string | null; days_left: number | null; state: string; sync_refused: boolean; trial: boolean;
  sync_stops_at?: string | null; gated?: boolean;
}
const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** The client list's expiry: "Expires in 5 days" / "Expires today" / "Lapsed 3 days" / "Paid to 23 Nov 2026"; null off the plan. */
export function expiryText(c: CloudStandingView | null | undefined): { text: string; tone: Tone } | null {
  if (!c || !c.paid_until || c.days_left === null || c.days_left === undefined) return null;
  const d = c.days_left;
  if (c.state === "ended") return { text: "Trial ended — sync stopped", tone: "bad" };
  if (d < 0) return { text: `Lapsed ${dayWord(-d)}${c.sync_refused ? " — sync stopped" : ""}`, tone: "bad" };
  if (d === 0) return { text: "Expires today", tone: "bad" };
  if (d <= 14) return { text: `Expires in ${dayWord(d)}`, tone: "warn" };
  return { text: `Paid to ${trialDate(c.paid_until)}`, tone: "ok" };
}

/** The Plan & billing card's headline and explanation. */
export function standingLine(s: CloudStandingView | null | undefined): { title: string; text: string; tone: Tone } {
  if (!s || !s.gated) return { title: "Not on a cloud plan", tone: "muted",
    text: "Set a plan or record a payment to put this client on it. Until then its tills sync as before (no lapse rule)." };
  if (!s.paid_until) return { title: "On a plan — no payment yet", tone: "warn", text: "Record the first payment to set the paid-until date." };
  const until = trialDate(s.paid_until);
  const stops = trialDate(s.sync_stops_at ?? null);
  const what = s.trial ? "Cloud trial" : "Paid";
  if (s.sync_refused) return { title: s.state === "ended" ? "Trial ended — sync stopped" : `Lapsed — ended ${until}`, tone: "bad",
    text: "The cloud refuses this client's tills' sync and no till can be joined. The tills keep selling and keep their sales; recording a payment opens sync again at once and the queue drains." };
  const d = s.days_left ?? 0;
  if (d < 0) return { title: `Lapsed ${dayWord(-d)} — in grace until ${stops}`, tone: "bad",
    text: `Everything still works until ${stops} (the 21-day grace); then sync stops and no till can be joined until a payment is recorded.` };
  return { title: `${what} until ${until} — ${d === 0 ? "today" : `${dayWord(d)} left`}`, tone: d <= 14 ? "warn" : "ok",
    text: s.trial
      ? `No grace after a trial: sync stops on ${until}. Recording a payment converts the trial.`
      : `If unpaid, the 21-day grace runs to ${stops}; then sync stops and no till can be joined. Reminders go to the owner and ZapTill at 14, 7, 3 and 1 day(s), on the day, and weekly while lapsed.` };
}

/** The reminder milestone in words. */
export function milestoneText(m: string): string {
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
