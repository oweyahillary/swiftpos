/**
 * transport — gets bytes to a printer.
 *
 * ONE implementation, used by both the Electron main process and the local
 * print server that serves the web POS. Two copies would drift, which is how
 * printReceipt and printKOT ended up disagreeing.
 *
 * ── WHY NOT THE OS PRINT PIPELINE ────────────────────────────────────────────
 * The path being replaced went through PowerShell's Out-Printer, which hands
 * the job to the Windows GDI spooler. GDI RENDERS: it lays out a document,
 * rasterises it, and sends a bitmap. For a 494-byte receipt that is several
 * orders of magnitude of work, and it is where the ten-second print came from.
 *
 * Every route below delivers the bytes verbatim. Nothing rasterises anything.
 *
 * ── THE THREE ROUTES, IN ORDER OF PREFERENCE ─────────────────────────────────
 *   network  TCP to port 9100. The printer's own firmware consumes ESC/POS
 *            directly. Nothing installed on the till, any till can reach any
 *            printer, and relocating one means changing an IP.
 *   share    A Windows share path, \\host\PrinterName. Writing to it as a file
 *            sends RAW bytes and skips GDI. This is how a USB printer is
 *            reached from Node without a native addon: share it locally, then
 *            write to \\localhost\ThatName.
 *   device   A unix device node, /dev/usb/lp0. Direct write.
 *
 * No route shells out, so no printer name is ever parsed by a shell.
 */

import { createWriteStream } from 'fs';
import { Socket } from 'net';

export type PrinterTarget =
  | { kind: 'network'; host: string; port?: number }
  | { kind: 'share'; path: string }
  | { kind: 'device'; path: string };

export interface SendOptions {
  /** Milliseconds to wait for connect and for the write to drain. */
  timeoutMs?: number;
}

export class PrinterError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'PrinterError';
  }
}

/**
 * `retryable` distinguishes "the printer is off, try again in a minute" from
 * "this target does not exist, stop trying". The spool needs that difference:
 * retrying a bad address forever fills a queue with jobs that can never drain,
 * and the operator never finds out why nothing prints.
 */
export async function sendToPrinter(
  target: PrinterTarget,
  bytes: Buffer,
  opts: SendOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  switch (target.kind) {
    case 'network': return sendNetwork(target.host, target.port ?? 9100, bytes, timeoutMs);
    case 'share':
    case 'device': return sendFile(target.path, bytes, timeoutMs);
  }
}

function sendNetwork(host: string, port: number, bytes: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let settled = false;

    const done = (err?: PrinterError) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      err ? reject(err) : resolve();
    };

    sock.setTimeout(timeoutMs, () =>
      done(new PrinterError(`timed out after ${timeoutMs}ms connecting to ${host}:${port}`, true)));

    sock.on('error', (e: NodeJS.ErrnoException) => {
      // ENOTFOUND and EADDRNOTAVAIL mean the address is wrong, not busy.
      const permanent = e.code === 'ENOTFOUND' || e.code === 'EADDRNOTAVAIL';
      done(new PrinterError(`${host}:${port} — ${e.message}`, !permanent));
    });

    sock.connect(port, host, () => {
      // Wait for the kernel to hand the bytes off before reporting success. A
      // resolve on write() alone reports a job as printed that may never leave
      // the socket buffer.
      sock.end(bytes, () => done());
    });
  });
}

function sendFile(path: string, bytes: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: PrinterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };

    const timer = setTimeout(
      () => done(new PrinterError(`timed out after ${timeoutMs}ms writing to ${path}`, true)),
      timeoutMs,
    );

    const stream = createWriteStream(path, { flags: 'w' });
    stream.on('error', (e: NodeJS.ErrnoException) => {
      const permanent = e.code === 'ENOENT' || e.code === 'EACCES';
      done(new PrinterError(`${path} — ${e.message}`, !permanent));
    });
    stream.on('finish', () => done());
    stream.end(bytes);
  });
}

/** Parses "192.168.1.50:9100", "\\\\localhost\\Kitchen", "/dev/usb/lp0". */
export function parseTarget(spec: string): PrinterTarget {
  if (spec.startsWith('\\\\')) return { kind: 'share', path: spec };
  if (spec.startsWith('/')) return { kind: 'device', path: spec };
  const [host, port] = spec.split(':');
  if (!host) throw new PrinterError(`cannot parse printer target "${spec}"`, false);
  return { kind: 'network', host, port: port ? Number(port) : 9100 };
}
