# Morning report — 2026-10-30

Two pieces of work are ready, in two folders. Nothing is committed or pushed.

## 1. Main folder (C:\swiftpos\pos, branch dev): A608 part 3

### The manager page (/manager) is retired
- **Moved to the dashboard first:**
  - **Parking bays live view:** on the Overview page, for parking businesses only. It shows total, occupied, free, occupancy, cars over 8 hours and the cars in the bays, and refreshes every 30 seconds.
  - **Shift report print:** a "Shift report" button on Open drawers prints on the branch receipt printer.
- **Redirect:** /manager now sends people to the dashboard, or to the sign-in page if they're signed out. The "← Manager portal" button is gone.
- **Deleted:** the `pages/manager/` folder (only the old page used it) and `SupplierBills.tsx` (Stock › Suppliers shows the same bills).
- **Tests:** six tests that checked only the old page were deleted. Tests that also checked other things were trimmed or moved to the new homes.

### Who can give web access
| Who | May give, resend or revoke web access |
|---|---|
| Owner | Anyone except the owner's role, as before |
| Partner or manager with staff rights (`staff.edit`) | Only someone at their own branches, with no more rights than they have. Never themselves, the owner's role or a General Manager. |
| Anyone else | No |

**Making a Partner stays owner-only.** A non-owner also can't make one indirectly:
- moving a web-access holder onto General Manager is refused;
- renaming a web-access holder's role to General Manager is refused.

**Supervisor:** counts as a manager by its rights (recorded; no change).

### Also in this commit
- **Permission check:** the checker can now see the dashboard menu's permission rules.
- **Test fixed:** `partner-my-branches-a582` had expired fixed dates; they're now relative to today.
- **Parking panel colours:** recorded as status colours (occupancy thresholds, free bays, amount due).
- **Light-colours block:** regenerated. Six rules went with the deleted pages.

### CI
The full step set is clean apart from the known Windows noise:
- the schema audit (no python3 on this PC);
- the money-reports TZ case;
- the libuv crash after all cases had passed.

Two checks were stale because of the deletions (light colours, web POS green); both are fixed and pass. The A608 test passes 45 of 45, and every related staff, partner and web test passes.

### Commit
```bash
cd /c/swiftpos/pos
git add -A apps/dashboard apps/server docs e2e scripts tests
git status --short
git commit -m "Manager portal retired on the web: parking bays live view and shift report print moved to the dashboard, /manager redirects to the dashboard; partners and managers with staff rights give, resend and revoke web access within their branches and rights, never the owner's role, a General Manager or themselves, and never make a partner indirectly by role change or rename (A608 part 3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin dev
```
`git status --short` should be empty before the commit.

### Decide: four things only the old manager page had
Tell me which, if any, to rebuild on the dashboard:
1. **Receiving a transfer line by line**, with a note. Stock › Transfers marks the whole transfer received in one go.
2. **Remote day close with a counted cash figure.** Tills & days closes the day without one.
3. **The A4 "Print Z"** from its Reports. The receipt-printer shift report replaces it.
4. **The manager credit-limit box.**

### Check on dev after it deploys
- `/manager` opens the dashboard.
- A parking business shows the bays live view on Overview.
- The shift report prints from Open drawers.
- A manager with staff rights can give a cashier web access, but not a General Manager or someone at another branch.

## 2. Shared components (C:\swiftpos\pos-shared, branch shared-components): batches C and D

### Batch C: 9 modules
orderNotes, kitchenLines, delivery, scaleBarcode, barcode, labels, offers, parkingTariff and forecourt.

### Batch D: 4 modules
posFeatures, release, permissions and shiftConfirm.

### Where it stands
- `packages/core` now holds 40 modules.
- Copy paths left: 63 → 3, all `numberInputs`, which is step 3.

### Verified
- **Builds:** every app builds.
- **Unchanged output:**
  - The web dashboard, web POS and admin build output is byte-identical.
  - The compiled permissions, posFeatures and release are byte-identical across server, desktop and core.
  - The POS main chunk is unchanged at 445,575 bytes.
- **Checks:** all 31 checks pass.
- **CI:** the full set shows only the known noise.
- **Test installer:** 1.0.20, `--publish never`. All 40 modules load from inside the packaged app.

### Exceptions and one change to accept
- **Two files with the same name are not copies.**
  - The desktop's `forecourt.ts` reads SQLite.
  - The server's `shiftConfirm.ts` holds the cloud's own confirm rules.
  - The sync check allows them only while they stay different.
- **Desktop build output.** It is not byte-identical: one unused CSS rule (`.lowercase`) dropped out because it came from a comment in a deleted file. That renamed the chunk files; the code inside is identical.

### Commit (one commit, because C and D are mixed in the same files)
```bash
cd /c/swiftpos/pos-shared
git add -A apps docs packages scripts tests
git status --short
git commit -m "Shared components batches C and D: orderNotes, kitchenLines, delivery, scaleBarcode, barcode, labels, offers, parkingTariff, forecourt, posFeatures, release, permissions and shiftConfirm moved to packages/core (40 modules), app copies deleted (63 -> 3 copy paths, numberInputs left for step 3), imports switched to @zaptill/core; desktop forecourt and server shiftConfirm kept as their own modules under a guarded exception; every app builds, outputs byte-identical except one unused CSS rule, packaged installer verified" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin shared-components
```
`git status --short` should be empty before the commit.

### Next on that branch, after you commit
1. **Merge dev in** (I prepare it; you commit). Expect 13 conflicts where dev edited an app copy that batch D deleted: 5 permissions, 5 posFeatures, 3 release. Each is resolved by deleting the copy. Two new dev files also need their imports switched: `dayClose.ts` and `webPosSignIn.ts`.
2. **Remaining steps:** `numberInputs` and the shared UI step, then the header-comment refresh.
3. **Render:** change the root directory before this branch reaches dev.

## 3. Still on your list
- **Release:**
  - Give web access to every manager who uses the web today, before the cloud deploy.
  - Migration 181 must run on prod before the cloud deploy, and the cloud deploy goes out together with the next desktop release.
- **Prod Render:** `BRANCH_DRAWERS_MEMO_S=300`. Send me Render's message if it's still refused.
- **Your standing items:**
  - Approve and roll out 1.0.22.
  - Mary's cash-in fix.
  - Rotate the prod DB password.
  - The duplicate owners at Magas.
  - The 32-bit rollout.
  - Close the port 4370 forwarding.
  - Reply yes or no to the K40 test writes.
