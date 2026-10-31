# Morning report — 2026-10-31

Built overnight, in two folders. Nothing is committed, pushed or deployed. Both full CIs are clean (details in each section).

## 1. Main folder (C:\swiftpos\pos, dev): the cloud per branch, all four phases, plus A613 and A614

### What you can now do (A612)
- **Each branch has its own cloud plan:** period, price, paid-until, and its own 7 unpaid days. A branch that does not pay is
  cut off on its own:
  - its POS send nothing and receive nothing (not even a price change), and keep selling offline;
  - nobody sees its data on the web, the owner included;
  - the other branches carry on;
  - when it pays, its sales since the cut-off upload in quiet hours.
- **One invoice per business, to the owner**, for the branches due that day.
  - It lists Item, Qty (branches), Unit price and Amount; the period appears once at the top.
  - A note under the total lists each branch and what it has.
  - Items: Cloud, Analytics, Attendance, Themes, or the Premium package (KES 15,000: the Cloud and every premium item).
  - Sample: `docs/samples/cloud-invoice-per-branch.html`.
- **Premium per branch.** Analytics, Attendance and Themes work only at the branches that pay for them, or are on the
  package. The business's own switch (Features) stays your master switch.
- **Admin portal, client › Plan & billing › "Cloud per branch":**
  - each branch's plan, premium, package, paid-until and where it stands;
  - **Edit** per branch, including **Disable this branch now**;
  - **Record payment for branches:** tick the branches; it shows what each one covers and the amount expected first;
  - **Bill per branch** for a client still billed as one.
- **Admin portal, Billing page › "Billing details":** your company name, address, KRA PIN, phone, M-Pesa Paybill or Till,
  the account reference, and the monthly prices.
  - Until you save it, invoices print the sample, marked "Sample details".
  - The prices are placeholders until you set them: Cloud 3,000, Analytics 10,000, Attendance 2,000, Themes 1,000,
    package 15,000.
- **A branch you add for a client billed per branch** gets its own plan, due that day.

### Rules worth knowing
| Situation | What happens |
|---|---|
| A payment ticks only some branches | Only invoices of exactly those branches are marked paid; a shared invoice stays open until all of its branches are paid. |
| A locked branch pays | Its new period starts that day, and its locked time's invoice is closed, not charged (pay as you go). |
| The business's paid-until | Becomes the latest of its branches, so sign-in stays open while any branch is paid. |
| Every branch paused | The whole dashboard pauses, as today. |
| A branch not paying for Themes | Its POS keeps the standard look. A premium change reaches the POS within its next check. |

### Also in this commit
- **A613:** the new sidebar header (logo, name and bell on one row; a full-width branch picker).
- **A614:** one attendance device per branch. A second is refused; migration 183 enforces it in the database too.

### Migrations — not yet
- **182 (branch plans):** run on prod only together with the deploy of this work.
  - Before it runs, nothing changes for anyone.
  - Once it runs, every branch inherits its business's plan and paid-until, so nobody is locked by it.
- **183 (one device per branch):** first run this read-only check; no rows means it is safe:
  ```sql
  SELECT branch_id, count(*) FROM attendance_devices WHERE removed_at IS NULL GROUP BY branch_id HAVING count(*) > 1;
  ```

### CI
- **Full run:** 268 steps, 8 flagged.
  - Seven are the usual Windows noise: no python3, the migrations install, the money-reports time zone, and crashes on exit
    after all cases pass.
  - The eighth, the A584 billing test, failed only while the other CI ran beside it. Alone it passes 27/27, twice.
- **Every test file rerun on its own:** one real failure, the theme test pinning the old Themes line. Updated; 17/17.
- **New tests:**
  - `branch-billing-a612` (22);
  - `branch-cloud-a612` (32);
  - the A582 leak sweep with a paused branch (29);
  - migrations 182 (11) and 183 (6).
  - Every new test was broken on purpose to prove it catches the fault.

### Commit
```bash
cd /c/swiftpos/pos
git add -A .github apps/admin apps/dashboard apps/desktop apps/server docs migrations scripts tests
git status --short
git commit -m "Cloud billed per branch (A612, migration 182): each branch its own plan, paid-until and 7 unpaid days; an unpaid or disabled branch cut off on its own - its POS refused both ways, its data hidden from every user (every read swept), the web paused only when every branch is; one invoice per business to the owner for the branches due, itemised (Cloud, Analytics, Attendance, Themes, Premium package) with the branches in a note; payments for the branches ticked (each its own period, a locked one afresh), Bill per branch, a new branch billed from its first day; ZapTill's billing details and prices in the admin portal; premium per branch (analytics, attendance, the POS's themes); one attendance device per branch (A614, migration 183); sidebar header redesigned (A613)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin dev
```
`git status --short` should be empty before the commit.

### To check on dev after the deploy (migration 182 NOT run on dev)
- The sidebar header and picker.
- Attendance › Devices: a branch with a device offers no "Add device".
- Admin portal › a client › Plan & billing: "Cloud per branch" says the client is billed as one (no branch plans yet).
- Admin portal › Billing: "Billing details" shows the sample. Saving it there is safe.

To try per-branch billing for real on dev, run migration 182 on the dev database and use one test client.

## 2. Shared components (C:\swiftpos\pos-shared): batch E

No copies of shared files are left anywhere: the sync check says "45 modules live in packages/core and packages/ui with
no copies". 63 paths changed. Details in section 8d of the shared-components plan (in the pos-shared folder).

### What moved
- **Into `packages/core` (42 modules now):** `customerScreen` and `customerDetails`, both pure. Their 8 app copies are
  deleted.
- **Step 3 has started:** a new `packages/ui` (`@zaptill/ui`) holds the two customer-screen views (`CustomerScreenView`,
  `CustomerAskForm`) and `numberInputs`.
  - React is a peer dependency, never a copy in the package.
  - The dashboard and the desktop link it like core. Each lockfile change is the link entry only.
  - Their 4 app copies are deleted, and `apps/desktop/src/shared` is gone.
- **The sync check also guards:**
  - a copy growing back in an app;
  - a relative import of either package;
  - `@zaptill/ui` in the cloud or the desktop's main process.

### Two technical points
- **`preserveSymlinks`** is on in the dashboard and desktop (TypeScript and Vite). Without it the shared views could not
  find React and core.
- **The dashboard's chunk rule** now keeps `@zaptill` code out of the eagerly loaded vendor chunk, so pages still load
  their own pieces lazily.

### Verified
- All apps typecheck and build.
- The desktop's screen build is byte-identical to before; the dashboard is identical apart from build timestamps.
- The POS main chunk is unchanged at 446.4 kB.
- **Fixed on the way:** four tests left broken by the dev merge commit (migration tests 175–177, `brand-polish`) still
  read the old copies; they now read `packages/core`.

### CI
- **Full run:** 265 steps, 11 flagged.
  - Nine are the usual Windows noise.
  - Two were those merge leftovers, now fixed.
- **Every test file rerun on its own:** only the known money-reports time-zone case remains.

### Commit
```bash
cd /c/swiftpos/pos-shared
git add -A apps docs packages scripts shared tests
git status --short
git commit -m "Shared components batch E: customerScreen and customerDetails moved to packages/core (42 modules); step 3 begins with packages/ui (@zaptill/ui: CustomerScreenView, CustomerAskForm, numberInputs; React a peer, resolved through each app's link with preserveSymlinks, kept out of the dashboard's vendor chunk); 12 app copies deleted, no copies left (check-shared-sync guards both packages and keeps @zaptill/ui out of the cloud and the desktop main process); desktop renderer output byte-identical, dashboard identical apart from build timestamps, POS main chunk unchanged at 446.4 kB; dev-merge leftovers fixed (migration tests 175-177, brand-polish read packages/core)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin shared-components
```

### Next on that branch
1. Merge dev in again once section 1 is committed. A612, A613 and A614 touch shared-module imports; I'll prepare it.
2. Step 3 continues: the POS screen pieces (`MethodDot`, `WeightModal`, `Pager`, …) into `packages/ui`, one at a time,
   with screenshots.
3. Render's root-directory change before this branch reaches dev.

## 3. Your question: will shared components make microservices easier later?

Yes, they're the first step, but they are not microservices themselves.

**What they give you:**
- **One copy of each rule:** permissions, POS features, billing, themes and the rest now live in one package
  (`@zaptill/core`) that every app imports.
- **Rules that travel:** a separate service can import the same package and apply exactly the same rules, with nothing
  copied and nothing drifting apart. That's the hardest part of splitting a system.

**What microservices would still need:**
- **Separate programs:** today the cloud is one server with every route.
- **Each service owning its own data:** today one database is shared by everything.
- **A way for services to talk:** calls or events between them.

**My view: not yet.** At your size, one well-organised server is cheaper and safer, and that matters with the move to one
KES 2,500 VPS. The realistic next step, when needed, is to run the heavy background jobs as separate processes on the same
VPS, using `@zaptill/core`:
- billing;
- the watchdog;
- eTIMS;
- analytics.

That gets the main benefit (a slow job never slows the POS) without the cost of full microservices.

## 4. Still on your list
- Approve and roll out 1.0.22. Rotate the prod DB password. Close the port 4370 forwarding. Yes or no on the K40 test
  writes. Mary's cash-in fix. The Magas duplicate owners. The 32-bit rollout.
- KRUNCH & CO: before restoring their licence, cancel their two day closes from 24 Oct on Tills & days.
- After the next deploy: check the Supabase card (A611 should bring branch-drawers calls down).
