/**
 * NoConnection — "No connection — can't sell" (Till stage 1 sells only online; offline selling is Till stage 2). It
 * COVERS the PIN pad and the selling screen and closes nothing, so an order on the screen is still there when the
 * connection comes back. This tablet's own page (/pos/device: updates, printers, Reset app) stays open.
 */
import { Link, useLocation } from 'react-router-dom';
import { NO_CONNECTION } from '../../shop/rules';

export default function NoConnection({ online }: { online: boolean }) {
  const { pathname } = useLocation();
  if (online || pathname.startsWith('/pos/device')) return null;
  return (
    <div className="cover" role="alertdialog" aria-live="assertive" data-testid="no-connection">
      <div className="card">
        <h2>No connection — can't sell</h2>
        <p>{NO_CONNECTION}</p>
        <p className="note">Checking again every few seconds. Nothing on the screen is lost.</p>
        <Link className="ghost link-button" to="/pos/device">This device</Link>
      </div>
    </div>
  );
}
