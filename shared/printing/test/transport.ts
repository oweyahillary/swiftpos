/**
 * Exercises the transport against a real TCP listener standing in for a
 * printer, so the network path is genuinely tested rather than reasoned about.
 * Confirms the bytes arrive byte-identical, that a dead address fails fast, and
 * that a bad hostname is reported as permanent rather than retryable.
 */

import { createServer, Server } from 'net';
import { renderTicket, toEscPos, receiptPreset } from '../src/index';
import { sendToPrinter, parseTarget, PrinterError } from '../src/transport';
import { order, business } from './fixture';

const PORT = 19100;

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

function listener(): Promise<{ server: Server; received: Promise<Buffer> }> {
  return new Promise(resolve => {
    let resolveRecv: (b: Buffer) => void;
    const received = new Promise<Buffer>(r => { resolveRecv = r; });
    const server = createServer(sock => {
      const chunks: Buffer[] = [];
      sock.on("data", (c: Buffer) => chunks.push(c));
      sock.on('end', () => resolveRecv(Buffer.concat(chunks)));
    });
    server.listen(PORT, '127.0.0.1', () => resolve({ server, received }));
  });
}

async function main() {
  const doc = renderTicket({ order, business, station: receiptPreset('st-till', 'Till') });
  const bytes = toEscPos(doc, { cut: true, openDrawer: true, feedBeforeCut: 3 });

  const { server, received } = await listener();

  const t0 = Date.now();
  await sendToPrinter({ kind: 'network', host: '127.0.0.1', port: PORT }, bytes);
  const elapsed = Date.now() - t0;

  const got = await received;
  server.close();

  check('bytes arrive intact', got.equals(bytes), `${got.length} of ${bytes.length} bytes`);
  check('delivered under 100ms', elapsed < 100, `${elapsed}ms`);

  // A closed port on loopback refuses immediately: retryable, because the
  // printer may simply be switched off.
  try {
    await sendToPrinter({ kind: 'network', host: '127.0.0.1', port: 19999 }, bytes, { timeoutMs: 2000 });
    check('closed port rejects', false);
  } catch (e) {
    const err = e as PrinterError;
    check('closed port rejects', err instanceof PrinterError);
    check('closed port is retryable', err.retryable === true, err.message);
  }

  // A hostname that does not resolve is a configuration error, not a busy
  // printer. Retrying it forever would fill the spool with undrainable jobs.
  try {
    await sendToPrinter({ kind: 'network', host: 'no-such-printer.invalid', port: 9100 }, bytes, { timeoutMs: 3000 });
    check('bad host rejects', false);
  } catch (e) {
    const err = e as PrinterError;
    check('bad host is permanent', err.retryable === false, err.message);
  }

  check('parse network target', JSON.stringify(parseTarget('192.168.1.50:9100')) ===
    JSON.stringify({ kind: 'network', host: '192.168.1.50', port: 9100 }));
  check('parse default port', (parseTarget('192.168.1.50') as any).port === 9100);
  check('parse share path', parseTarget('\\\\localhost\\Kitchen').kind === 'share');
  check('parse device path', parseTarget('/dev/usb/lp0').kind === 'device');

  console.log(failures === 0 ? '\nTransport verified.' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
