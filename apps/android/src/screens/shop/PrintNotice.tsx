/**
 * PrintNotice — what did not print, in words, over whatever screen is open (shop/printing.ts tells it). The web POS
 * screens count a failed print but, in a browser, have nowhere to say why; on a Shop POS a printer that is off must be
 * said (Till stage 1). The sale is never affected: it was saved before anything printed.
 *
 * Retry: when the last failure is retryable (the printer was off, not a bad address), offer one tap to redo it once the
 * printer is back on — no need to re-ring the sale or dig it out of History (shop/printRetry.ts). A retry that fails
 * raises a fresh notice; one that succeeds clears this one.
 */
import { useEffect, useState } from 'react';
import { PRINT_PROBLEM_EVENT, canRetryLastPrint, retryLastPrint } from '../../shop/printing';

export default function PrintNotice() {
  const [words, setWords] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const on = (e: Event) => { setWords((e as CustomEvent<string>).detail); setCanRetry(canRetryLastPrint()); };
    window.addEventListener(PRINT_PROBLEM_EVENT, on);
    return () => window.removeEventListener(PRINT_PROBLEM_EVENT, on);
  }, []);

  if (!words) return null;

  const onRetry = async () => {
    setRetrying(true);
    try {
      await retryLastPrint();
      setWords(null);   // it printed — clear the notice
    } catch {
      // The retry failed too: printing.ts has already raised a fresh notice via the event, which updates `words`.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="print-notice" role="alert" data-testid="print-notice">
      <span>🖨 {words}</span>
      {canRetry && (
        <button className="ghost" onClick={onRetry} disabled={retrying} data-testid="print-retry">
          {retrying ? 'Printing…' : 'Retry'}
        </button>
      )}
      <button className="ghost" onClick={() => setWords(null)}>OK</button>
    </div>
  );
}
