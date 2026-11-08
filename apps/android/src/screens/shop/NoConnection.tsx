/**
 * NoConnection — "No connection — can't sell" (Till stage 1 sells only online; offline selling is Till stage 2). It
 * COVERS the PIN pad and the selling screen and closes nothing, so an order on the screen is still there when the
 * connection comes back. This tablet's own page (/pos/device: updates, printers, Reset app) stays open.
 */
import { useLocation, useNavigate } from 'react-router-dom';
import { NO_CONNECTION } from '../../shop/rules';
import { useLongPress } from '../../shop/useLongPress';

export default function NoConnection({ online }: { online: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // The cover hides the PIN screen's header, so the technician door lives here too: long-press the card to open This
  // device (printer setup, Reset app) — the one reliable way in while offline.
  const techDoor = useLongPress(() => navigate('/pos/device'));
  // Till stage 2: the selling screen keeps working offline (sales are buffered), so the cover no longer blocks it — only
  // the PIN pad, where a sign-in still needs the cloud. The SyncStatusBar shows the offline / queued state while selling.
  if (online || pathname.startsWith('/pos/device') || pathname.startsWith('/pos/cashier')) return null;
  return (
    <div className="cover" role="alertdialog" aria-live="assertive" data-testid="no-connection">
      <div className="card" {...techDoor}>
        <h2>No connection — can't sell</h2>
        <p>{NO_CONNECTION}</p>
        <p className="note">Checking again every few seconds. Nothing on the screen is lost.</p>
      </div>
    </div>
  );
}
