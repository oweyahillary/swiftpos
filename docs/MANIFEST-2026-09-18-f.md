# Delivery manifest — 2026-09-18 (-f) · release 0.5.47 (A299 logging)

Applied via apply-a299-docs.mjs (search-replace) because `git apply` fought the Windows CRLF checkout.
Code delivered separately as swiftpos-0.5.47-code.patch (6 files). Register + this manifest by the script.

A299: capture all errors (main console hook + renderer forwarder) and event summaries
(sale/void/refund/shift/config — id/total/method/count + changed keys only, never values or line items)
into swiftpos.log; startup build stamp logged; rotation 1MB->5MB. Version 0.5.46 -> 0.5.47.

Verify after: `node scripts/check-register-consistency.mjs` green; build:all prints "Packaging v0.5.47".
