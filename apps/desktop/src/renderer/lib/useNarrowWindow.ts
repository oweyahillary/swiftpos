/**
 * useNarrowWindow — A537: a POS window too narrow to give the category panel its own column beside the grid and the
 * cart; the panel then lies over the grid (POSPage passes `overlay={narrowWindow}`).
 *
 * Moved out of components/CategoryPanel.tsx in shared components batch G (docs/SHARED-COMPONENTS-PLAN.md section 8g):
 * that file is now the desktop's look for @zaptill/ui/CategoryPanel and re-exports this hook, so POSPage's import is
 * unchanged. The web decides by its own phone / tablet rule (`isPhone`).
 */
import { useEffect, useState } from 'react';

export const NARROW_WINDOW_PX = 1100;

export function useNarrowWindow(): boolean {
  const read = () => { try { return window.innerWidth < NARROW_WINDOW_PX; } catch { return false; } };
  const [narrow, setNarrow] = useState<boolean>(read);
  useEffect(() => {
    const on = () => setNarrow(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return narrow;
}
