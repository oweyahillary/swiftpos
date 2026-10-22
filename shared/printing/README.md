# shared/printing

Ticket rendering for the POS. Turns an order into the bytes a thermal printer
wants, for any number of stations.

Nothing here imports from the existing print code. `printReceipt`, `printKOT`,
`printDispatcher`, `thermal`, `ticketLines`, `qzTray`, `usePaperGeometry` and
`apps/print-server` are all replaced by this package — do not wire it alongside
them, wire it instead of them.

## Where this goes

Master copy lives here, at `shared/printing/`, matching the convention already
used by `shared/parkingTariff.ts`. When wiring, copy the folder into the app
that consumes it:

    shared/printing/                    <- master, edit here
    apps/desktop/src/shared/printing/   <- copy, for the Electron main process

`escpos.ts` uses `Buffer`, so it is Node-only. Everything else — including
`preview.ts` — is pure and runs in a browser, which is what lets the settings
screen preview without a printer attached.

## Running it

    cd shared/printing
    npm ci
    npm run sample             # print the sample tickets to the terminal
    npm test                   # every suite, plus the reference-artefact check

`npm run sample` renders the sample order to all three stations plus a
duplicate, on both 80mm and 58mm, and checks the tax arithmetic against two
receipts photographed from the incumbent system.

### Reference artefacts (A314)

`SAMPLE-OUTPUT.txt` and `out/*.bin` are the committed output of the CURRENT
renderer — the text a reviewer reads and the bytes an owner sends to a printer
(`copy /b out\receipt-80.bin \\localhost\<printer>`). `npm test` re-renders
both and fails, naming the file and the first differing line or byte, if either
has drifted. So when a change moves the paper on purpose:

    npm run refresh-artefacts  # rewrites out/*.bin and SAMPLE-OUTPUT.txt
    git diff SAMPLE-OUTPUT.txt # the review: only the lines you meant to move
    node ../../scripts/build-escpos-renderer.mjs   # the web POS bundle, same change

and commit all of it together. CI also rebuilds the web bundle
(`build-escpos-renderer.mjs --check`, esbuild pinned) and fails if it is stale.
`BYTE-CHECK.txt` was refreshed for A551 (2026-10-21: kitchen tickets back in Font A, the item gap and 1-line feed on kitchen and dispatch tickets, the receipt's large payment block) and A557 (2026-10-21: kitchen dish names at the dispatch ticket's normal size, the payment block double height only); A559 (2026-10-22: extras on the kitchen ticket as "+ Extra Cheese") changed SAMPLE-OUTPUT only — the byte fixture carries no extra, so BYTE-CHECK is unchanged; `VERIFICATION.txt` is a one-off capture from 2026-08-05 and
is NOT maintained — its byte counts predate the receipt closing block.

Compiles clean under `strict: true`. The three app tsconfigs are currently
`strict: false`; do not relax this one to match them.

## How it fits together

    order + business + station config
              |
              v
        render.ts  ->  Document  ->  escpos.ts  -> bytes -> printer
                            |
                            +----->  preview.ts -> text  -> settings screen

The `Document` in the middle is the point. Both serialisers consume the same
one, so the settings preview is not a second implementation of the layout that
can disagree with the first. A preview that looks right IS right.

## Stations are flags, not types

Kitchen, dispatch and receipt are one renderer under three sets of flags. There
is no `isCombo`, no hardcoded list of three ticket kinds, and no per-client
branching. A restaurant with a bar, a grill, a cold pass, a dispatch bench and a
till configures five stations off the same struct.

`kitchenPreset` / `dispatchPreset` / `receiptPreset` in `index.ts` exist so a new
business has working stations on day one. Copy one and change the flags.

## Decisions still open

Marked `(UNSETTLED)` in `index.ts` so they are greppable. Each currently matches
the approved mockups; each is one boolean.

  emphasizeParent      double-height dish names on the kitchen ticket (off since
                       A557: bold at normal size, as the dispatch ticket)
  aggregateUnits       collapse identical units across lines, vs per-parent
  showFooterCount      the "5 items to cook" / "3 bags" line
  showOptionPrices     net price deltas beneath a receipt line
  attributeStyle       inline when simple, vs always on a sub-line

Two deviations from the drawn mockups, both deliberate:

  - Attribute sub-lines print the full unit name (`3PC Chicken  1 spicy, 2
    normal`) rather than a shortened one. Auto-abbreviating a product name is
    guesswork.
  - 80mm is 48 columns, not the 42 that was drawn. 42 is Font B; Font A is
    wider and materially easier to read across a counter. Same arrangement,
    more room.
  - A543 (owner, 2026-10-21: "change the font of the kitchen printer, packing
    is okay"): KITCHEN tickets print in Font B (9x17 dots) — 64 columns on
    80mm, 42 on 58mm, lines 24 dots apart (ESC M 1 … ESC M 0, ESC 3 24). The
    per-client switch `kitchen_font_a` put the Font A kitchen ticket back.
  - A551 (owner, 2026-10-21, on paper: "kitchen receipt use the same font as
    the despatcher"): KITCHEN tickets are Font A again — the dispatch ticket's
    font, size and columns — and Font B is the per-client opt-in
    `kitchen_font_b` (`kitchen_font_a` is retired). Kitchen and dispatch
    tickets put a thin gap (ESC J 10, ~1.25 mm) between items instead of a
    blank line, feed 1 line before the cut, and print a variant on the item's
    own row ("Chicken Burger - Spicy", as the receipt does). The receipt's
    payment block is "BUY GOODS:" / the number, centred, double size, bold.
    Dispatch and receipts are always Font A.
  - A557 (owner, 2026-10-21, on paper: "kitchen receipt font are not the same
    as the packaging receipt, they are bold and big i want exactly as the
    packaging/dispatcher receipt EXACT FONT SIZE AND FONT, also reduce the font
    size of paybill a bit"): the kitchen preset's emphasizeParent is off, so a
    dish name is bold at normal size, byte for byte the dispatch ticket's row
    (Font B kitchen tickets too). The payment block's label and number are
    double HEIGHT only (GS ! 0x01), always — ESC/POS has no size between that
    and A551's double size — and a long value wraps at the full line.

## Not built yet

  - Transport. Raw TCP to port 9100, USB/serial device handle, and the Win32
    spooler with pDatatype="RAW" so the job skips GDI rendering entirely.
  - The spool. A SQLite `print_jobs` table with per-station queues, retry and
    backoff, so the till never blocks on a printer and an offline station
    catches up when it returns.
  - eTIMS. No fiscal QR or control unit block, because it has not been
    specified. Absent rather than faked.
  - Logo bitmaps. Text headers only for now.
