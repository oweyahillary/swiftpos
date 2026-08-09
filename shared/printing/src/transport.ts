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
  | { kind: 'device'; path: string }
  /** Windows print spooler, RAW datatype. Takes the printer's DISPLAY name. */
  | { kind: 'spooler'; name: string };

export interface SendOptions {
  /** Milliseconds to wait for connect and for the write to drain. */
  timeoutMs?: number;
}

export class PrinterError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /**
     * True when the fault was in SwiftPOS, not in the printer or the address.
     * The UI must not offer a hardware diagnosis for one of these — telling
     * somebody to check a power cable because our own script threw sends them
     * to the wrong place, and it happened three times before this existed.
     */
    readonly internal = false,
  ) {
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
    case 'spooler': return sendSpooler(target.name, bytes, timeoutMs);
  }
}

/**
 * Windows print spooler, RAW datatype — the way point-of-sale software has
 * always done this, and the reason a USB printer needs no share.
 *
 * WHY NOT THE PRINT DIALOG
 * The obvious idea is a picker like Word's. That dialog prints through the
 * DRIVER: it lays the job out, rasterises it and spools it as an image, which
 * is exactly what mangles a 42-column ticket. Microsoft's own description of
 * the RAW datatype is the distinction — RAW data "can be sent to a print
 * monitor without further processing", the spooler just hands the bytes on.
 * That is what a thermal printer wants: our ESC/POS, untouched.
 *
 * WHY NOT A NATIVE MODULE
 * OpenPrinter/StartDocPrinter/WritePrinter is the C API for this, and the npm
 * bindings for it need node-gyp and a C++ toolchain on every build machine.
 * PowerShell can P/Invoke the same winspool.drv exports through Add-Type, and
 * PowerShell is on every Windows install. Same API, same RAW datatype, nothing
 * to compile and nothing extra to ship.
 *
 * The bytes go via a temp FILE rather than stdin: PowerShell's stdin applies
 * text encoding, and a single mangled 0x1B turns a formatted receipt into
 * gibberish. ReadAllBytes has no opinion about what the bytes mean.
 *
 * AddJob's contract has one sharp edge, documented by Microsoft: if JobStream
 * is not closed before the thread ends, the spooler cannot take ownership and
 * it throws. Hence the try/finally around the close.
 */
/**
 * Turn a PowerShell failure into a PrinterError that says something TRUE.
 *
 * Exported and pure so it can be tested without Windows. Three times running,
 * this screen told an installer to check the power and the cable on a printer
 * that was switched on and working, because the classifier guessed from message
 * text and guessed wrong. The rule now:
 *
 *   - a fault the SPOOLER reported  -> talk about the printer
 *   - anything else                 -> say it is our bug, and do not speculate
 *
 * `retryable` drives the spool's back-off, so a wrong answer here also means a
 * job retried for hours against a printer that will never accept it, or
 * abandoned when it would have succeeded a minute later.
 */
export function classifySpoolerFailure(name: string, raw: string): PrinterError {
  const msg = raw.trim();
  const first = msg.split('\n')[0].trim();

  // Win32 codes come out of our own C# as "(1801)". They are the only part of
  // this string that is a fact rather than prose.
  const code = /\((\d+)\)\s*$/.exec(first)?.[1] ?? /\((\d+)\)/.exec(msg)?.[1];

  const SPOOLER_CODES: Record<string, { text: string; retryable: boolean }> = {
    '1801': { text: 'the spooler does not recognise that printer name', retryable: false },
    '5':    { text: 'access denied — this Windows account may not print to it', retryable: false },
    '1804': { text: 'the printer rejected the RAW datatype; its driver may not accept raw printing', retryable: false },
    '1722': { text: 'the print spooler service is not running', retryable: true },
    '63':   { text: 'the spooler dropped the job', retryable: true },
  };

  const fromSpooler = /OpenPrinter|StartDocPrinter|StartPagePrinter|WritePrinter|short write/i.test(msg);

  if (fromSpooler) {
    const known = code ? SPOOLER_CODES[code] : undefined;
    return new PrinterError(
      `${name} — ${first}${known ? ` — ${known.text}` : ''}`,
      known ? known.retryable : true,
    );
  }

  // Not from the spooler: PowerShell itself failed, or our script did. Neither
  // is a printer fault, and neither gets better by waiting.
  return new PrinterError(
    `${name} — ${first}`,
    false,
    true,   // internal
  );
}

async function sendSpooler(name: string, bytes: Buffer, timeoutMs: number): Promise<void> {
  if (process.platform !== 'win32') {
    throw new PrinterError('the Windows spooler is only available on Windows', false);
  }

  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const { execFile } = await import('node:child_process');

  const tmp = pathMod.join(os.tmpdir(), `swiftpos-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  await fsp.writeFile(tmp, bytes);

  // ── HOW THE TWO VALUES REACH THE SCRIPT ─────────────────────────────────
  // Environment variables, not $args.
  //
  // This was three separate failures on real hardware before the cause was
  // clear, and they all had the same root:
  //
  //     powershell.exe -Command <script> -args <name> <tmp>
  //
  // -args does NOT bind when -Command is used. -Command takes the REST of the
  // line as the command to run, so "-args", the printer name and the temp path
  // were appended as stray text and $args stayed empty. Every failure was then
  // the script reacting to an empty string:
  //
  //     GetPrintQueue('')   -> "exception occurred while populating properties"
  //     ReadAllBytes('')    -> "Empty path name is not legal"
  //
  // Both were read as evidence about the printer. Neither was about the printer.
  //
  // Environment variables sidestep the whole question: nothing is parsed,
  // nothing is quoted, and a printer named  Kitchen'; Remove-Item C:\  is just a
  // string. -File with a temp .ps1 would also work, but that is another file to
  // write, secure and clean up on a machine where the last one might still be
  // there from a crash.
  const env = { ...process.env, SWIFTPOS_PRINTER: name, SWIFTPOS_DATA: tmp };

  const ps = `
    $ErrorActionPreference = 'Stop'
    $printer = $env:SWIFTPOS_PRINTER
    $dataPath = $env:SWIFTPOS_DATA
    if ([string]::IsNullOrWhiteSpace($printer))  { throw 'SWIFTPOS_PRINTER was not set' }
    if ([string]::IsNullOrWhiteSpace($dataPath)) { throw 'SWIFTPOS_DATA was not set' }
    $sig = @'
using System;
using System.Runtime.InteropServices;
public static class SwiftRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr h, IntPtr buf, int len, out int written);

  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("OpenPrinter failed for '" + printer + "' (" +
        Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "SwiftPOS ticket";
      di.pDatatype = "RAW";
      if (!StartDocPrinter(h, 1, ref di))
        throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h))
          throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        IntPtr buf = Marshal.AllocCoTaskMem(data.Length);
        try {
          Marshal.Copy(data, 0, buf, data.Length);
          int written;
          if (!WritePrinter(h, buf, data.Length, out written))
            throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
          if (written != data.Length)
            throw new Exception("short write: " + written + " of " + data.Length);
        } finally { Marshal.FreeCoTaskMem(buf); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
    Add-Type -TypeDefinition $sig -Language CSharp
    $bytes = [System.IO.File]::ReadAllBytes($dataPath)
    [SwiftRaw]::Send($printer, $bytes)
  `;

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: timeoutMs, windowsHide: true, env },
        (err, _stdout, stderr) => {
          if (!err) { resolve(); return; }
          reject(classifySpoolerFailure(name, String(stderr || err.message)));
        },
      );
    });
  } finally {
    await fsp.unlink(tmp).catch(() => { /* temp file, best effort */ });
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
      // Windows reports a UNC path that does not resolve to a share as
      // UNKNOWN, not ENOENT. Left out of this list, the commonest setup mistake
      // there is — a USB printer that has never been shared — was classified
      // RETRYABLE, and the screen told the installer to check the power and the
      // cable on a printer that was switched on and working.
      //
      // None of these get better by waiting. They are all configuration.
      const permanent =
        e.code === 'ENOENT'   // no such path
        || e.code === 'EACCES'   // no permission on the share
        || e.code === 'UNKNOWN'  // Windows: UNC target is not a share
        || e.code === 'ENXIO'    // device node exists, nothing behind it
        || e.code === 'EPERM';

      const isUnc = path.startsWith('\\\\');
      const hint = permanent && isUnc
        ? ` — no share by that name. On Windows a printer must be shared before `
          + `raw printing works: printer properties, Sharing tab, tick "Share this `
          + `printer", and use the SHARE name here (it is not always the printer name).`
        : '';

      done(new PrinterError(`${path} — ${e.message}${hint}`, !permanent));
    });
    stream.on('finish', () => done());
    stream.end(bytes);
  });
}

/**
 * Parses "printer:XP-80", "192.168.1.50:9100", "\\\\localhost\\Kitchen",
 * "/dev/usb/lp0".
 *
 * `printer:` is the preferred form for anything plugged into this machine: it
 * goes through the spooler by display name, so the printer does not have to be
 * shared and the name is the one Windows already shows in Devices and Printers.
 */
export function parseTarget(spec: string): PrinterTarget {
  if (spec.startsWith('printer:')) {
    const name = spec.slice('printer:'.length).trim();
    if (!name) throw new PrinterError('printer: needs a printer name after it', false);
    return { kind: 'spooler', name };
  }
  if (spec.startsWith('\\\\')) return { kind: 'share', path: spec };
  if (spec.startsWith('/')) return { kind: 'device', path: spec };
  const [host, port] = spec.split(':');
  if (!host) throw new PrinterError(`cannot parse printer target "${spec}"`, false);
  return { kind: 'network', host, port: port ? Number(port) : 9100 };
}
