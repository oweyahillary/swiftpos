# Verification log — 2026-09-15

Session: **one laptop + printer, no 2nd machine.** Test business **"B Foods / Mama Ngina"**
on the dev cloud, Kudo menu imported. Register updated alongside this log.

## Closed on target (14) — verified on the current build
A265 (charge no crash), A266 (receipt not blank), A260 (receipt shows the business name),
A274 (no sale without an open shift), **A275 (remote day close — verified end-to-end)**,
A182 (reinstalled till, one device no duplicate), and the printing set A235 (silent print),
A249 + A251 (station routing, web = desktop), A240 (bridge locked down), A245 (no pairing
token), A239 (bridge installer), A241 (dashboard finds bridge), A243 (old print path retired).

Bonus validated live on a real receipt: the **spice modifier** end-to-end (Spicy / Normal
per line) and **VAT 16%** computed correctly.

## Reported pass but on the PRE-rebuild front-end — RE-CONFIRM before closing
A259, A262, A257, A256, A179, A129, A157, D18. These were ticked in the first checklist run,
before the Vercel front-end was rebuilt from our code (see A281). Kept FIX BUILT; re-run on
the current build next session.

## Real defects found
- **A276 (P1)** — a **soda prints on the KITCHEN ticket** (should be dispatch/receipt only),
  on **both web and desktop**. Shared routing unit tests pass, so live inputs differ. Cause
  not yet diagnosed — need: the Soda product settings (is_kitchen?), the print-station config,
  and photos of both tickets. (Folds in the A209/A264 target fails.)
- **A273** — the "which till are you covering?" picker renders, but it still **asks for an
  opening float even when the till already has an open drawer**; it should resume/fold-in, not
  re-prompt. Kept FIX BUILT with the note; fix queued.

## Findings opened
- **A276** P1 — soda on kitchen ticket (above).
- **A277** P2 — receipt omits the CTL (Catering/Tourism Levy) line though it's computed/stored.
- **A278** P2 — web→till changes need a till restart; owner wants **instant direct push** (real-time).
- **A279** P3 — POS has no visible category-filter control (owner UX idea).
- **A280** P1 — a clean rebuild from baseline+migrations does **not** reproduce production
  (7 columns + a table missing; drift both ways). Disaster-recovery risk; overlaps A23.
- **A281** P2 — front-end (Vercel/`main`) and back-end (Render/`dev`) deploy from **different
  branches**; a feature isn't live until both deploy. Cost hours today.

## Skipped / not reached
- A236 (didn't build the bridge .exe; used the shared build).
- A267 (needs a time-based wait for token expiry).
- A264 physical kitchen-exclusion — folded into A276.

## Blocked — needs a 2nd enrolled till (Group C, all FIX BUILT, code ready)
A273 two-surface fold-in, D9 (held orders across tills), A162/A19 (peer relay + offline
sales), A163/A20 (roster replicate + failover), A161/A24 (reference data), A160 (offline
session refresh), A164 (write-guard), A22 promote-refusal. Ready the moment Laptop B is
installed as **Till T2** and one machine is promoted to node.

## Environment notes (not features)
- **CTL** left at `ctl_rate = 0` deliberately so the main run's tax figures stay clean.
  Flip to 2% only for the one A277 check after the receipt CTL line is built.
- The **test DB** carries the A280 drift; it's outside the shift/POS path so it didn't affect
  today's items.

## Next session
1. Diagnose **A276** from the three artefacts (soda settings, print-station config, ticket photos)
   → fix is either menu-data (is_kitchen on drinks) or the router; decide from the data.
2. Enrol **Laptop B as Till T2** + promote a node → run all of **Group C**.
3. Build the queued fixes: **A273** (skip float when a drawer is already open), **A277**
   (receipt CTL line), and scope **A278** (instant push). Re-confirm the 8 pre-rebuild items.
