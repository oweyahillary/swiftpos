/**
 * cloudPaused.ts — A584: the words of the paused screen (components/CloudPausedScreen.tsx) and of the sign-in page's
 * paused card. Pure, so the test reads them. Owner, 2026-10-23: no blame, no dates, no countdown.
 */
export type PausedCode = 'CLOUD_ACCESS_PAUSED' | 'CLOUD_TRIAL_ENDED';
export const PAUSED_TITLE = 'Your ZapTill cloud access is paused';
export const PAUSED_BODY = 'Call 0717 675 635 to renew.';
/** The owner's words in one sentence (the title and the body read together). */
export const PAUSED_SENTENCE = `${PAUSED_TITLE}. ${PAUSED_BODY}`;

export function pausedWords(code: PausedCode): { title: string; body: string } {
  if (code === 'CLOUD_TRIAL_ENDED') {
    return { title: 'Your cloud trial has ended', body: 'Your one-month cloud trial is over. Call ZapTill on 0717 675 635 to keep the web dashboard. Your tills keep working as before.' };
  }
  return { title: PAUSED_TITLE, body: PAUSED_BODY };
}
