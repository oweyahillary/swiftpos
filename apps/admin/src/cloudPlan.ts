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
      text: "The owner can still sign in to read reports for 7 days after the trial, then sign-in stops. Points of sale are not affected. Convert to paid to keep the dashboard." };
  }
  // A587: a trial ends like a paid period — the invoice on its end day, the 7 days, then locked.
  return { title: `Cloud trial ended ${end} — invoiced`,
    text: `An invoice went to the client on ${end}, as for a paid client. Unpaid 7 days after it, everything locks (web dashboard, sync, joining a POS); points of sale keep selling. Convert to paid = Record payment below: it covers from ${end}.` };
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
  /** A587: when the client is (or would be) taken as "Not interested". */
  not_interested_at?: string | null;
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
  if (c.state === "off") return { text: "Web access off", tone: "bad" };   // A587: a hard off
  if (c.state === "not_interested") return { text: `Not interested (since ${trialDate(c.not_interested_at)})`, tone: "muted" };   // A587
  const t = c.trial ? "Trial ended — " : "";   // A587: a trial ends like a paid period
  if (c.trial) {
    if (c.state === "ended") return { text: "Trial ended — locked", tone: "bad" };
    if (c.state === "reports_only") return { text: "Trial ended — reports only", tone: "bad" };
    if (c.state === "active") {
      const d = c.days_left ?? 0;
      return { text: d <= 0 ? "Trial ends today" : `Trial — ends in ${dayWord(d)}`, tone: d <= 7 ? "warn" : "ok" };
    }
  }
  if (c.state === "locked") { const n = c.locked_days ?? 0; return { text: `${t}${n <= 0 ? `${t ? "l" : "L"}ocked today` : `${t ? "l" : "L"}ocked ${dayWord(n)}`}`, tone: "bad" }; }
  if (c.state === "unpaid") {
    const u = c.unpaid_days ?? 0, m = c.lock_in_days ?? 0;
    const lock = m <= 0 ? "locks tonight" : `locks in ${dayWord(m)}`;
    return { text: `${t}${u <= 0 ? `${t ? "d" : "D"}ue today (${lock})` : `${t ? "u" : "U"}npaid ${dayWord(u)} (${lock})`}`, tone: u >= 5 ? "bad" : "warn" };
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
  if (s.state === "off") return { title: "Web access off — switched off now", tone: "bad",
    text: `"Disable web access" is a hard off: the web dashboard is paused, the cloud refuses sync from this client's points of sale and no POS can be joined; nothing is invoiced. The points of sale keep selling. ${s.paid_until && Date.parse(s.paid_until) > Date.now() ? `Enable web access again (paid until ${trialDate(s.paid_until)} is still ahead), or record a payment.` : "To switch it back on, record a payment (or a complimentary paid-until)."}` };
  if (s.state === "not_interested") return { title: `Not interested (since ${trialDate(s.not_interested_at)})`, tone: "muted",
    text: `Unpaid for 3 months after ${trialDate(s.due_at ?? s.paid_until)}: no more invoices, the open cloud invoices were written off, and it stays locked (web, sync, joining a POS). The points of sale keep selling. If the client pays, the payment starts a fresh period from that day — pay as you go, no arrears.` };
  if (!s.gated) return { title: "Not on a cloud plan", tone: "muted",
    text: "No web access. Record a payment (or a complimentary paid-until) to turn it on and put this client on the plan." };
  if (!s.paid_until) return { title: "On a plan — no payment yet", tone: "warn", text: "Record the first payment to set the paid-until date." };
  const due = trialDate(s.due_at ?? s.paid_until);
  const lastOpen = s.lock_at ? trialDate(new Date(Date.parse(s.lock_at) - 1).toISOString()) : "—";
  if (s.trial) {
    if (s.state === "ended") return { title: "Trial ended — locked", tone: "bad",
      text: "The trial was ended (web access switched off): sync is stopped and no POS can be joined; the points of sale keep selling. Recording a payment converts the trial and opens everything at once." };
    if (s.state === "reports_only") return { title: "Trial ended — reports only", tone: "bad",
      text: "Sync is stopped and no POS can be joined; the points of sale keep selling. Recording a payment converts the trial and opens everything at once." };
    if (s.state === "active") return { title: `Cloud trial — ends ${due}`, tone: (s.days_left ?? 0) <= 7 ? "warn" : "ok",
      text: `No invoice during the trial. On ${due} an invoice goes to the client, as for a paid client; unpaid 7 days after it, it locks at the end of ${lastOpen}. Recording a payment converts it.` };
  }
  const tr = s.trial ? "Trial ended — " : "";   // A587: after its end a trial is billed like a paid client
  if (s.state === "locked") return { title: `${tr}Locked — unpaid since ${due}`, tone: "bad",
    text: `The web dashboard is paused (${s.trial ? "\"Your cloud trial has ended\"" : "\"Your ZapTill cloud access is paused. Call 0717 675 635 to renew.\""}), the cloud refuses sync from this client's points of sale and no POS can be joined. The points of sale keep selling and keep their sales. Pay as you go: a payment starts a fresh period from the day it is made (the locked time is not charged — its unpaid invoice is closed) and opens everything at once; the queue drains. Unpaid 3 months (to ${trialDate(s.not_interested_at)}), it is taken as not interested.` };
  if (s.state === "unpaid") {
    const u = s.unpaid_days ?? 0, m = s.lock_in_days ?? 0;
    return { title: `${tr}${u <= 0 ? "Due today" : `Unpaid ${dayWord(u)}`} — locks ${m <= 0 ? "tonight" : `in ${dayWord(m)}`} (end of ${lastOpen})`, tone: u >= 5 ? "bad" : "warn",
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
  if (m === "not_interested") return "not interested — invoices written off (to ZapTill)";   // A587
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

// ── A587: what a payment covers (the Record payment form; POST …/cloud-plan/payments/preview) ─────────────────────────
export interface CoverInvoice { invoice_number: string; period_start: string | null; period_end: string | null; amount: number }
export interface CoverView {
  from: string; until: string; fresh: boolean; settles: CoverInvoice[]; closes?: CoverInvoice[];
  not_interested_at?: string | null; state?: string;
}
const span = (a: string | null | undefined, b: string | null | undefined) => `${trialDate(a)} – ${trialDate(b)}`;
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * A587 (owner, 2026-10-24: "it's pay as you go, not pay for missed months, since they won't be using the system at that
 * time"): the line under Record payment — a locked client: "Starts a new period: 24 Oct 2026 – 24 Nov 2026. INV-2026-0012
 * (not used while paused) is closed, not charged." Within the 7 days: "Pays INV-… (23 Oct 2026 – 23 Nov 2026); paid until …".
 */
export function coversLine(c: CoverView | null | undefined): string | null {
  if (!c || !c.until) return null;
  const closes = c.closes ?? [];
  const closed = closes.length
    ? ` ${andList(closes.map((i) => i.invoice_number))} (not used while paused) ${closes.length === 1 ? "is" : "are"} closed, not charged.` : "";
  if (c.fresh) return `${c.state === "not_interested" ? `Not interested since ${trialDate(c.not_interested_at)} — s` : "S"}tarts a new period: ${span(c.from, c.until)}.${closed}`;
  if (c.settles.length) return `Pays ${andList(c.settles.map((i) => `${i.invoice_number} (${span(i.period_start, i.period_end)})`))}; paid until ${trialDate(c.until)}.`;
  return `Covers ${span(c.from, c.until)} (a new paid invoice); paid until ${trialDate(c.until)}.`;
}

// ── A601: the desktop-only cut-off (lib/cloudPlan.ts desktopOnlyView; the cloud's DESKTOP_ONLY_CUTOFF_AT) ────────────
/** A desktop-only client's cut-off, as GET /clients rows' `desktop_only` and GET /clients/:id carry it. */
export interface DesktopOnlyView {
  phase: "none" | "notice" | "cut"; cutoff_at: string | null; exempt: boolean; updates_released: boolean;
  backup_off: boolean; updates_held: boolean; notice: boolean;
}
/** The cloud's cut-off date, as the client list and detail carry it. */
export interface CutoffView { at: string | null; phase: "none" | "notice" | "cut" }

/**
 * A601: a desktop-only client's line — the client list's Billing column (when nothing is billed) and the Features tab:
 *   "Desktop only" (no date set) · "Desktop only — backup stops 1 Dec 2026" · "Desktop only — backup off since …" ·
 *   "Desktop only — backup kept (exempt)". null: not desktop only.
 */
export function desktopOnlyText(d: DesktopOnlyView | null | undefined): { text: string; tone: Tone } | null {
  if (!d) return null;
  if (d.exempt) return { text: "Desktop only — backup kept (exempt)", tone: "ok" };
  if (d.phase === "notice") return { text: `Desktop only — backup stops ${trialDate(d.cutoff_at)}`, tone: "warn" };
  if (d.phase === "cut") return { text: `Desktop only — backup off since ${trialDate(d.cutoff_at)}`, tone: "bad" };
  return { text: "Desktop only", tone: "muted" };
}

/** A601: the cut-off date in words for the Features tab and the list header. */
export function cutoffLine(c: CutoffView | null | undefined): string {
  if (!c || !c.at || c.phase === "none") return "No cut-off date is set on the cloud (DESKTOP_ONLY_CUTOFF_AT): desktop-only clients keep the cloud backup and updates.";
  return c.phase === "notice"
    ? `Cut-off ${trialDate(c.at)}: until then desktop-only POSs show the notice; from then their backup and updates stop unless switched on below.`
    : `Cut-off ${trialDate(c.at)} has passed: desktop-only POSs no longer back up to the cloud and get no update unless switched on below.`;
}

/** A601: the update line for a desktop-only client (the Desktop updates tab). null: updates follow the approval as usual. */
export function desktopUpdatesLine(d: DesktopOnlyView | null | undefined): string | null {
  if (!d || d.phase === "none") return null;
  if (d.updates_released) return "Desktop only: updates are released to this client (Features › Release desktop updates) — the approved version below is offered.";
  return d.phase === "cut"
    ? "Desktop only: no update is offered (the POS says “Updates for this business are released by ZapTill support”). To release one, approve the version and switch on Features › Release desktop updates."
    : `Desktop only: from ${trialDate(d.cutoff_at)} no update is offered unless released (Features › Release desktop updates).`;
}
