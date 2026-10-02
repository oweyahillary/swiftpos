# A295 Slice 1c — logo upload validation (folded-in spec)

For when the upload UI is built (web portal + desktop). Applies to both surfaces,
enforced server-side too (never trust the client). Accent is set in the portal only;
this spec is for the **logo**.

## Accepted
- **SVG** (preferred) or **PNG** or **JPG/JPEG**.
- Recommend to the client: *"Transparent PNG, ~512 px on the longest side, artwork that reads on a light background — or a clean SVG."*

## Limits (reject with a clear message)
- **Max file size:** 250 KB (logos are stored base64 in the branding row and synced to every till — keep them small).
- **Max dimensions (raster):** 1024 px longest edge. Downscale on the client before upload if larger; hard-reject over ~2048 px.
- **Min dimensions (raster):** ~128 px longest edge (avoid a blurry logo on the card).
- **Aspect:** any; the logo-card uses `object-fit: contain`, so tall/wide/square all seat fine.

## SVG handling (the important one — an SVG is code)
Sanitize every uploaded SVG before storing/rendering. Reject or strip:
- `<script>`, `on*` handlers, `<foreignObject>`.
- external refs: `href`/`xlink:href` to anything off-document, `<image href="http…">`, `<use href="http…">`, CSS `@import`, `url(http…)`.
- `<metadata>` / provenance blobs (e.g. C2PA) — strip (they're 60–80% of file size; we stripped one from the SwiftPOS mark: 20 KB → 12.5 KB).
Require/prefer:
- text **outlined to paths** (no `<text>`), else it renders in whatever font the machine has. If `<text>` is present, warn the client.
Store the **sanitized** string, not the original.

## Background / colour guidance (surface, not enforced)
- Transparent is best; it composites on the white logo-card.
- Artwork must read **on a light background** (the card is white). A white/very-light mark will vanish — warn on near-white average luminance if cheap to detect.

## Receipt note (later slice, not 1c)
When `logo_receipt` (the thermal mono raster) is generated: reduce to 1-bit at ~384–576 px wide. Simple high-contrast marks reproduce; gradients/fine detail turn to mud. Worth surfacing to clients whose logo will also print.

## Where it plugs in
- Desktop upload path → validate before writing the local `branding` row.
- Web portal upload → validate client-side for UX + **again on the server** before persisting to `business_branding`.
- Add the SVG sanitizer as a small shared helper (same synced-copies pattern as `contrast.ts`) so desktop and server sanitize identically.
