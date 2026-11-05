/**
 * PrintNotice — what did not print, in words, over whatever screen is open (shop/printing.ts tells it). The web POS
 * screens count a failed print but, in a browser, have nowhere to say why; on a Shop POS a printer that is off must be
 * said (Till stage 1). The sale is never affected: it was saved before anything printed.
 */
import { useEffect, useState } from 'react';
import { PRINT_PROBLEM_EVENT } from '../../shop/printing';

export default function PrintNotice() {
  const [words, setWords] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setWords((e as CustomEvent<string>).detail);
    window.addEventListener(PRINT_PROBLEM_EVENT, on);
    return () => window.removeEventListener(PRINT_PROBLEM_EVENT, on);
  }, []);
  if (!words) return null;
  return (
    <div className="print-notice" role="alert" data-testid="print-notice">
      <span>🖨 {words}</span>
      <button className="ghost" onClick={() => setWords(null)}>OK</button>
    </div>
  );
}
