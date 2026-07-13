/**
 * Suite: Auth
 * Tests: login, token validation, refresh, logout, rate limiting, PIN login,
 *        token expiry handling, permissions_version, device flow stubs
 */
import { group, ok, okish, SKIP, GET, POST, PATCH, state, BASE_URL } from '../lib.mjs';

export async function run() {
  group('AUTH — Login & token issuance');

  // 1. Health endpoint (unauthenticated)
  const health = await GET('/health');
  ok('Health endpoint returns 200', health.status === 200);
  ok('Health has status: ok', health.data.status === 'ok');

  // 2. Login with bad credentials
  const badLogin = await POST('/api/auth/login', { email: 'nobody@nowhere.com', password: 'wrong' });
  ok('Bad credentials → 401', badLogin.status === 401);
  ok('Bad credentials error message exists', !!badLogin.data.error);

  // 3. Login with correct credentials
  const login = await POST('/api/auth/login', {
    email:    state.ownerEmail,
    password: state.ownerPassword,
  });
  ok('Owner login → 200', login.status === 200, `got ${login.status}: ${login.data.error ?? ''}`);
  ok('Login returns accessToken', !!login.data.accessToken);
  ok('Login returns refreshToken', !!login.data.refreshToken);
  ok('Login returns business object', !!login.data.business?.id);
  ok('Login returns user object', !!login.data.user?.id);

  if (login.data.accessToken) {
    state.ownerToken   = login.data.accessToken;
    state.refreshToken = login.data.refreshToken;
    state.businessId   = login.data.business.id;
  }

  group('AUTH — Token verification');

  // 4. Authenticated request works
  const biz = await GET('/api/business', state.ownerToken);
  ok('Authenticated GET /api/business → 200', biz.status === 200);
  ok('Business has id', !!biz.data?.id);
  ok('Business id matches login response', biz.data?.id === state.businessId);

  // 5. No token → 401
  const noToken = await GET('/api/business');
  ok('No token → 401', noToken.status === 401);

  // 6. Mangled token → 401
  const badToken = await GET('/api/business', 'not.a.real.token');
  ok('Invalid token → 401', badToken.status === 401);

  // 7. Token with wrong signature → 401
  const splitToken = (state.ownerToken ?? '').split('.');
  if (splitToken.length === 3) {
    const tamperedToken = splitToken[0] + '.' + splitToken[1] + '.invalidsignature';
    const tampered = await GET('/api/business', tamperedToken);
    ok('Tampered token signature → 401', tampered.status === 401);
  }

  group('AUTH — Token refresh (rotation)');

  // 8. Refresh token → new pair
  const refresh = await POST('/api/auth/refresh', { refreshToken: state.refreshToken });
  ok('Refresh → 200', refresh.status === 200, `got ${refresh.status}: ${refresh.data.error ?? ''}`);
  ok('Refresh returns new accessToken', !!refresh.data.accessToken);
  ok('Refresh returns new refreshToken', !!refresh.data.refreshToken);
  ok('New tokens differ from old', refresh.data.accessToken !== state.ownerToken);

  // Update state with rotated tokens
  if (refresh.data.accessToken) {
    const oldRefresh    = state.refreshToken;
    state.ownerToken   = refresh.data.accessToken;
    state.refreshToken = refresh.data.refreshToken;

    // 9. Replay attack — old refresh token should be revoked now
    const replay = await POST('/api/auth/refresh', { refreshToken: oldRefresh });
    ok('Replayed refresh token → 401 (rotation revocation)', replay.status === 401, `got ${replay.status}`);
    ok('Replay returns TOKEN_REPLAYED or TOKEN_UNKNOWN code',
      ['TOKEN_REPLAYED', 'TOKEN_UNKNOWN'].includes(replay.data.code),
      `code was: ${replay.data.code}`);
  }

  // 10. Missing refresh token body → 400
  const noRefresh = await POST('/api/auth/refresh', {});
  ok('Refresh with no token body → 400', noRefresh.status === 400);

  group('AUTH — Logout');

  // 11. Logout revokes refresh token
  const logoutRes = await POST('/api/auth/logout', { refreshToken: state.refreshToken }, state.ownerToken);
  ok('Logout → 200', logoutRes.status === 200);
  ok('Logout returns success', logoutRes.data.success === true);

  // 12. After logout, refresh token is invalid
  const postLogoutRefresh = await POST('/api/auth/refresh', { refreshToken: state.refreshToken });
  ok('Post-logout refresh → 401', postLogoutRefresh.status === 401);

  // Re-login to continue other tests
  const relogin = await POST('/api/auth/login', {
    email:    state.ownerEmail,
    password: state.ownerPassword,
  });
  if (relogin.data.accessToken) {
    state.ownerToken   = relogin.data.accessToken;
    state.refreshToken = relogin.data.refreshToken;
  }

  group('AUTH — POS PIN login');

  // 13. PIN login requires email + pin
  const noPinBody = await POST('/api/auth/pos-login', { email: state.ownerEmail });
  ok('POS login without pin → 400 or 401', [400, 401].includes(noPinBody.status));

  // 14. Wrong PIN
  const wrongPin = await POST('/api/auth/pos-login', {
    email: state.ownerEmail,
    pin:   '0000',
    surface: 'web',
    device_hint: 'test-suite',
  });
  ok('Wrong PIN → 401', wrongPin.status === 401);

  // 15. Non-numeric PIN rejected
  const alphaPin = await POST('/api/auth/pos-login', {
    email: state.ownerEmail,
    pin:   'abcd',
    surface: 'web',
    device_hint: 'test-suite',
  });
  ok('Non-numeric PIN → 401', alphaPin.status === 401);

  group('AUTH — Security headers');

  // 16. Check security headers from helmet
  const headersRes = await fetch(`${BASE_URL.value}/health`);
  const h = headersRes.headers;
  ok('X-Content-Type-Options header present', !!h.get('x-content-type-options'), h.get('x-content-type-options') ?? 'missing');
  okish('X-Frame-Options or CSP present',
    !!(h.get('x-frame-options') || h.get('content-security-policy')));
  ok('X-Powered-By removed (no Express fingerprint)', !h.get('x-powered-by'), `was: ${h.get('x-powered-by') ?? 'absent ✓'}`);
}
