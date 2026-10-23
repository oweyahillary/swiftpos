/**
 * desktopVersions.ts — A356 (2026-09-28): the admin portal's version list, short.
 *
 * Owner's screenshot (v0.6.17): the Desktop updates picker listed every build back to 0.5.48 — a long list to misclick
 * in. Approving an old version can never downgrade a till (the till refuses anything not newer), so this is about
 * picking the right one quickly: the newest few, plus the version the client is approved for if it is older, and
 * "Show all versions" for the rest.
 *
 * Pure, so the test runs it. Input is the cloud's list, newest first.
 */
export const RECENT_VERSIONS = 5;

export function visibleVersions<T extends { version: string }>(
  releases: T[], approved: string | null | undefined, showAll: boolean, recent = RECENT_VERSIONS,
): T[] {
  if (showAll || releases.length <= recent) return releases;
  const head = releases.slice(0, recent);
  const keep = approved ? releases.find((r) => r.version === approved) : undefined;
  return keep && !head.includes(keep) ? [...head, keep] : head;
}

// ── A534: "why isn't this till updating?" ─────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-20 ("add all of them since effort is small"): the Tills now list showed each till's version and nothing
// else (TJ'S PIZZA T1 on 1.0.5 while 1.0.19 was approved). From 1.0.20 a till reports its update state (migration 154,
// GET /api/admin/clients/:id/devices → updateState); an older till reports nothing, so its line comes from its version.

/** The report a till sends (apps/server/src/lib/updateState.ts keeps these fields). */
export interface TillUpdateState {
  running?: string | null; state?: string | null; version?: string | null; percent?: number | null;
  since?: string | null; checked_at?: string | null; approved?: string | null; error?: string | null;
  idle_note?: string | null; task?: boolean | null;
  /** A541: why it cannot install by itself, the branch server, waiting for the server's copy, since when, a start-up try. */
  blocker?: string | null; server?: boolean | null; waiting_server?: boolean | null; downloaded_at?: string | null; startup_failed?: boolean | null;
}
/** A541: a download waiting this long gets "ready for n days" on its line. */
export const READY_LONG_MS = 72 * 60 * 60_000;

/**
 * A541 (owner, 2026-10-20: "since we added the autostart feature most apps are not updating, they are stuck in the old
 * version"): the "Downloaded" line says WHY it has not installed — Windows would ask for permission (no ZapTill Updater
 * task: what to do about it), a start-up install that did not take, or the idle install's own reason ("waiting: in use 3
 * min ago (a till was trading)"). A report without these fields (A534's) reads as before. Pure.
 */
export function downloadedLine(s: TillUpdateState, v: string | null | undefined, now: number): string | null {
  const ver = v ? ` ${v}` : "";
  const long = s.downloaded_at && Number.isFinite(Date.parse(s.downloaded_at)) && now - Date.parse(s.downloaded_at) >= READY_LONG_MS
    ? ` · ready for ${Math.floor((now - Date.parse(s.downloaded_at)) / 86_400_000)} days` : "";
  // A546: a till opened by hand installs a waiting update first (Windows asks there — somebody is at the till).
  const after = s.server ? "or it installs at the next Windows sign-in" : "or it installs the next time ZapTill is opened (Windows will ask)";
  if (s.blocker && s.task === false) {
    return `Downloaded${ver} — can't install silently on this PC (no ZapTill Updater task): run the installer once as administrator, ${after}${long}`;
  }
  if (s.blocker) return `Downloaded${ver} — can't install by itself: ${s.blocker}${long}`;
  if (s.startup_failed) return `Downloaded${ver} — the install at Windows sign-in did not take; it installs when ZapTill is closed${long}`;
  if (s.downloaded_at && s.idle_note) return `Downloaded${ver} — ${s.idle_note}${long}`;
  return null;
}
export interface TillUpdateRow {
  appVersion?: string | null; lastSeenAt?: string | null; lastSyncAt?: string | null;
  updateState?: TillUpdateState | null; updateStateAt?: string | null;
}
export type UpdateTone = "ok" | "busy" | "warn" | "bad" | "muted";

/** -1 / 0 / 1 for "1.0.9" against "1.0.16" (numeric parts); a missing or odd version sorts first. */
export function compareTillVersions(a: string | null | undefined, b: string | null | undefined): number {
  const p = (v: string | null | undefined) => String(v ?? "").split(".").map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1; }
  return 0;
}

/** A till is silent when nothing (sync, sign-in, update report) has been heard for this long. */
export const SILENT_AFTER_MS = 24 * 60 * 60_000;
export const REPORTS_FROM = "1.0.20";
export const SELF_INSTALL_FROM = "1.0.16";

const hhmm = (iso: string | null | undefined): string => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const agoWords = (ms: number): string => {
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${Math.max(1, h)} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.round(ms / 86_400_000);
  return `${days} days ago`;
};

/** One short line per till for the Desktop updates card, and its colour. Pure (the test runs it). */
export function tillUpdateLine(dv: TillUpdateRow, approved: string | null | undefined, now = Date.now()): { text: string; tone: UpdateTone } {
  const heard = Math.max(...[dv.lastSyncAt, dv.lastSeenAt, dv.updateStateAt].map((s) => (s ? Date.parse(s) : 0)).filter(Number.isFinite), 0);
  const running = dv.updateState?.running || dv.appVersion || null;
  const behind = !!approved && !!running && compareTillVersions(running, approved) < 0;
  const silent = heard > 0 && now - heard > SILENT_AFTER_MS;
  const lastSeen = silent ? `Last seen ${agoWords(now - heard)}` : null;
  if (!heard) return { text: "Never seen", tone: "muted" };
  if (!behind) return silent ? { text: `${lastSeen} — up to date when last seen`, tone: "muted" } : { text: "Up to date", tone: "ok" };

  const s = dv.updateState;
  // A till from 1.0.20 reports its state; an older one only its version.
  if (!s || compareTillVersions(running, REPORTS_FROM) < 0) {
    const hint = compareTillVersions(running, SELF_INSTALL_FROM) < 0
      ? `Not checking — this till is older than ${SELF_INSTALL_FROM}: close ZapTill fully and reopen it; accept the Windows prompt`
      : "Installs itself when idle — if stuck, close and reopen ZapTill";
    return { text: lastSeen ? `${lastSeen} · ${hint}` : hint, tone: lastSeen ? "muted" : "warn" };
  }
  const v = s.version || approved;
  let line: { text: string; tone: UpdateTone };
  switch (s.state) {
    case "downloading":
    case "available":
      line = { text: `Downloading ${v}${typeof s.percent === "number" ? ` (${s.percent}%)` : ""}`, tone: "busy" }; break;
    case "downloaded":
      line = { text: downloadedLine(s, v, now)   // A541: why it has not installed (a report from before A541: as it was)
        ?? `Downloaded — installs when ZapTill is next closed${s.since ? ` (waiting since ${hhmm(s.since)})` : ""}${s.idle_note ? ` · ${s.idle_note}` : ""}`, tone: "warn" }; break;
    case "error":
      line = { text: `Update failed: ${s.error || "unknown error"}${s.since ? ` (at ${hhmm(s.since)})` : ""}`, tone: "bad" }; break;
    case "checking":
      line = { text: "Checking for the update", tone: "busy" }; break;
    default:
      line = { text: s.waiting_server   // A541: a till behind a branch server that has not got the version yet
        ? `Waiting for the branch server's copy of ${approved} — the server fetches it first${s.checked_at ? ` (last checked ${hhmm(s.checked_at)})` : ""}`
        : s.approved && compareTillVersions(s.approved, approved) < 0
        ? `Not told about ${approved} yet (it last heard ${s.approved}${s.checked_at ? ` at ${hhmm(s.checked_at)}` : ""})`
        : `Waiting to download ${approved}${s.checked_at ? ` (last checked ${hhmm(s.checked_at)})` : ""}`, tone: "warn" };
  }
  return lastSeen ? { text: `${lastSeen} · ${line.text}`, tone: "muted" } : line;
}
