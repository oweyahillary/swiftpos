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

/** Plan & billing: the trial line above "Convert to paid", or null when there is no unpaid trial. */
export function trialBillingLine(trial: CloudTrialView | null | undefined): { title: string; text: string } | null {
  if (!unpaidTrial(trial)) return null;
  const end = trialDate(trial.ends_at);
  if (trial.phase === "active") {
    return { title: `Cloud trial — ends ${end}`,
      text: "Started with the first desktop licence; no invoice was raised. Convert to paid enables web access for a year (KES 10,000) and raises the invoice." };
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
