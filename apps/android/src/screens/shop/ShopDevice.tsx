/**
 * ShopDevice — this tablet's own page (/pos/device): which business, branch and branch server it belongs to, its receipt
 * printer (saved and tested here), updates (only between shifts), and Reset app. Open without a connection too.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import UpdatePanel from '../UpdatePanel';
import { readServerLink, type ServerLink } from '../../shop/branchServer';
import { RawPrinter } from '../../native/plugins';
import { printerAddress } from '../../shop/rules';
import { readReceiptPrinter, saveReceiptPrinter } from '../../shop/printing';
import type { PosSession } from '../../shop/tillSession';

/** ESC @ (reset), a few lines, feed and cut — enough to prove the address and the paper. */
function testTicket(posName: string): string {
  const text = `ZapTill test print\n${posName}\n${new Date().toLocaleString()}\n\n\n`;
  const bytes = [0x1b, 0x40, ...Array.from(new TextEncoder().encode(text)), 0x1d, 0x56, 0x42, 0x00];
  return btoa(String.fromCharCode(...bytes));
}

const NOT_AN_ADDRESS = "Enter the printer's address on the shop network, for example 192.168.1.50.";

export default function ShopDevice({ till, version, onReset, onJoinAgain }: {
  till: PosSession; version: string; onReset: () => Promise<void>; onJoinAgain: () => void;
}) {
  const [server, setServer] = useState<ServerLink | null>(null);
  const [address, setAddress] = useState(readReceiptPrinter);
  const [printNote, setPrintNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => { void readServerLink().then(setServer); }, []);

  const saveAndTest = async () => {
    const a = printerAddress(address);
    if (!a) { setPrintNote(NOT_AN_ADDRESS); return; }
    saveReceiptPrinter(address);
    setPrintNote('Saved. Printing a test ticket…');
    try { await RawPrinter.send({ host: a.host, port: a.port, data: testTicket(till.posName) }); setPrintNote('Saved and sent. Check the printer.'); }
    catch (e) { setPrintNote(`Saved, but the test did not print: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const reset = async () => {
    setProblem('');
    try { await onReset(); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <main className="screen">
      <header className="brand"><span className="mark" aria-hidden="true">Z</span><span>ZapTill · Shop POS</span></header>
      <Link className="text-button" to="/pos">← Back to the PIN pad</Link>
      <section className="card">
        <h2>This POS</h2>
        <p><strong>{till.posName}</strong></p>
        <p className="note">{till.businessName}{till.branchName ? ` · ${till.branchName}` : ''}</p>
        {server
          ? <p className="note">Prints through the branch server <strong>{server.name}</strong> ({server.url.replace(/^http:\/\//, '')}, security code {server.securityCode}).</p>
          : <p className="note">No branch server: tickets go straight to the network printers.</p>}
      </section>

      <section className="card">
        <h2>Receipt printer</h2>
        <p className="note">
          The address on the shop network of the printer this POS prints its receipts on (port 9100 unless given, for example
          192.168.1.50:9100).{' '}
          {server
            ? "With a branch server, receipts print on the server's receipt printer; this one is used only when the server does not answer."
            : 'Kitchen and bar printers are set for the branch in the web dashboard (Settings › Printers), each named by its address.'}
        </p>
        <label className="field"><span>Receipt printer address</span>
          <input value={address} inputMode="decimal" autoCapitalize="none" onChange={(e) => setAddress(e.target.value)} />
        </label>
        <div className="actions"><button className="primary" onClick={() => void saveAndTest()}>Save and print a test ticket</button></div>
        {printNote && <p className="note">{printNote}</p>}
      </section>

      <UpdatePanel mode="shop-pos" version={version} />

      <section className="card">
        <h2>This device</h2>
        <p className="note">ZapTill {version} for Android</p>
        <div className="actions">
          <button className="ghost" onClick={onJoinAgain}>Join again (technician)</button>
          {!confirming && <button className="ghost danger" onClick={() => setConfirming(true)}>Reset app</button>}
        </div>
        {confirming && (
          <>
            <p>Reset app? This clears the device type, this POS's sign-in and everything ZapTill keeps on this device. A technician then joins it again.</p>
            {problem && <p className="problem">{problem}</p>}
            <div className="actions">
              <button className="primary danger" onClick={() => void reset()}>Reset app</button>
              <button className="ghost" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
