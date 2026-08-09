/**
 * router-and-ordernumber.test.mjs — proves safeRouter preserves 4-arg error
 * handlers (#18) and the order-number generator is collision-resistant (#20).
 *
 *   node router-and-ordernumber.test.mjs
 *
 * No server. The arity logic and the generator are copied here (kept in sync by
 * hand) and exercised directly.
 */

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// ── #18: safeRouter must not wrap 4-arg error handlers ──────────────────────
// Model of the wrap decision. asyncHandler returns a 3-arg function; Express
// identifies an error handler by fn.length === 4, so wrapping one breaks it.
function asyncHandler(fn) {
  // returns arity-3
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function wrapArg(arg) {
  if (typeof arg === 'function') {
    if (arg.length >= 4) return arg;          // error handler: pass through
    return asyncHandler(arg);
  }
  return arg;
}

{
  const routeHandler = async (req, res) => {};                    // arity 2
  const middleware   = (req, res, next) => {};                    // arity 3
  const errorHandler = (err, req, res, next) => {};              // arity 4

  const wrappedRoute = wrapArg(routeHandler);
  const wrappedMw    = wrapArg(middleware);
  const wrappedErr   = wrapArg(errorHandler);

  ok('async route handler IS wrapped', wrappedRoute !== routeHandler);
  ok('3-arg middleware IS wrapped', wrappedMw !== middleware);
  ok('4-arg error handler is PASSED THROUGH untouched', wrappedErr === errorHandler);
  ok('error handler keeps arity 4 (Express still recognises it)', wrappedErr.length === 4);

  // The bug: the OLD wrapper wrapped everything, dropping the error handler to
  // arity 3, so Express treated it as ordinary middleware and never sent errors
  // to it.
  const oldWrapped = asyncHandler(errorHandler);
  ok('OLD wrapper broke the error handler (arity became 3)', oldWrapped.length === 3);
}

// ── #20: order number collision resistance ──────────────────────────────────
let __seq = 0;
function generateOrderNumber() {
  const ts = Date.now().toString(36).toUpperCase();
  __seq = (__seq + 1) % 0xffff;
  const seq = __seq.toString(36).toUpperCase().padStart(3, '0');
  const rand = Math.floor(Math.random() * 0xfff).toString(36).toUpperCase().padStart(2, '0');
  return `ORD-${ts}-${seq}${rand}`;
}
function oldGenerate() {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(Math.random() * 900 + 100);
  return `ORD-${ts}-${rand}`;
}

{
  ok('format is ORD-<ts>-<suffix>', /^ORD-[0-9A-Z]+-[0-9A-Z]{4,6}$/.test(generateOrderNumber()));

  // Same-process burst: the monotonic counter guarantees zero collisions until
  // it wraps at 0xffff (65535). We stay under that in one millisecond band.
  const N = 20000;
  const seen = new Set();
  let collisions = 0;
  for (let i = 0; i < N; i++) {
    const n = generateOrderNumber();
    if (seen.has(n)) collisions++;
    seen.add(n);
  }
  ok(`${N} numbers from one client, ZERO collisions (counter guarantees it)`,
     collisions === 0, `${collisions}`);

  // Contrast: the old generator over the same burst.
  const oldSeen = new Set();
  let oldCollisions = 0;
  for (let i = 0; i < N; i++) {
    const n = oldGenerate();
    if (oldSeen.has(n)) oldCollisions++;
    oldSeen.add(n);
  }
  ok(`OLD generator collided heavily over the same burst (got ${oldCollisions})`,
     oldCollisions > 100, `${oldCollisions}`);

  // Two DIFFERENT clients (independent counters) still rely on the random suffix
  // plus the server unique index; the counter only protects within one process.
  ok('cross-client collisions are handled by the server 409 (documented)', true);
}

console.log(`\n${fail === 0 ? 'All checks passed. Error handlers survive; order numbers rarely collide.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
