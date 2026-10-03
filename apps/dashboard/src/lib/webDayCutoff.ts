/**
 * webDayCutoff.ts — 0.6.34: the business day's end as the web POS last heard it (pos/init's businessDayCutoff), for the
 * screens that ask "what is today" (History). 0 = midnight until told. See lib/businessDay.ts.
 */
import { cleanCutoff } from './businessDay';

let cutoffMinutes = 0;
export function setWebDayCutoff(raw: unknown): void { cutoffMinutes = cleanCutoff(raw) ?? 0; }
export function getWebDayCutoff(): number { return cutoffMinutes; }
