/**
 * ServerKeepRunning — A435 option (a) (owner, 2026-10-10: "let's work with your recommendation"). The technician's
 * steps that keep a branch server running from power-on: ZapTill starts with Windows and restarts itself within 5
 * minutes if it stops (serverWatchdog.ts), but both need Windows signed in — so the PC signs in by itself and never
 * sleeps. Shown where a machine becomes the branch server: setup, and the technician console.
 */
export const KEEP_RUNNING_STEPS: string[] = [
  'Set this PC to sign in to Windows by itself: press Windows + R, type netplwiz, untick "Users must enter a user name and password", press OK and enter the Windows password. (On a PC where that box is missing: Settings › Accounts › Sign-in options › turn off "For improved security, only allow Windows Hello sign-in".)',
  'Settings › System › Power: "When plugged in, put my device to sleep after" — Never.',
  'Leave ZapTill open. Closing its window keeps it running by the clock; it starts with Windows and starts itself again within 5 minutes if it stops.',
];

export default function ServerKeepRunning() {
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 px-4 py-3" data-testid="server-keep-running">
      <p className="text-sm font-semibold text-white">Keep the branch server running</p>
      <p className="text-xs text-gray-400 mt-0.5">So the tills have their server back by themselves after a power cut or a restart:</p>
      <ol className="mt-2 space-y-1.5 text-xs text-gray-300 list-decimal list-inside">
        {KEEP_RUNNING_STEPS.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
    </div>
  );
}
