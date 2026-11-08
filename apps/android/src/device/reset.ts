/**
 * reset.ts — "Reset app": back to the first-launch question, with nothing of the old mode left on the device
 * (docs/ANDROID-APP-DESIGN.md §2). Clears the mode and every preference, every stored secret (device/secrets.ts) and
 * every downloaded update.
 *
 * A Shop POS with unsent sales refuses the reset until they are sent, or until a technician confirms (the desktop's
 * Rejoin guard) — Till stage 2 answers resetBlocker() from the sales buffer; Stage 0 has none.
 */
import { clearPreferences } from './mode';
import { clearSecrets } from './secrets';
import { forgetDownloads } from '../updates/updater';
import { stopReporting } from '../errors/reporter';

/** Why the reset must wait, in words for the person; null = nothing stops it. */
export async function resetBlocker(): Promise<string | null> { return null; }

export async function resetApp(): Promise<void> {
  const blocker = await resetBlocker();
  if (blocker) throw new Error(blocker);
  await clearSecrets();
  await clearPreferences();
  await forgetDownloads();
  stopReporting();
}
