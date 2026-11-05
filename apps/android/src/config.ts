/**
 * config.ts — where the app finds the ZapTill cloud.
 *
 * Built into the APK (VITE_API_URL at build time; the cloud's address otherwise). The seams rule of the design
 * (pinch point 10): every call goes through cloud/client.ts with this base, never a hard-coded URL elsewhere — Till
 * stage 3 adds the branch server as a second authority target beside it.
 */
const DEFAULT_API_URL = 'https://api.zaptill.co.ke';

export const API_URL = String(import.meta.env.VITE_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
