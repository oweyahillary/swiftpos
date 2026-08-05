/**
 * bytes — decodes the generated ESC/POS stream back into a command list and
 * checks it is well-formed, then writes each ticket as a raw .bin.
 *
 * This is NOT a substitute for testing on a printer. It proves the stream is
 * structurally valid — every escape sequence is complete, every mode change is
 * one the command set defines, every text byte is inside the code page. It
 * cannot prove a given printer honours GS V 66, or that its drawer answers a
 * 50ms pulse. Only paper proves that.
 *
 * The .bin files exist so paper can prove it WITHOUT this package being wired
 * into anything. Send one straight at a printer:
 *
 *   Windows   copy /b receipt-80.bin \\localhost\ReceiptPrinter
 *   Network   nc 192.168.1.50 9100 < receipt-80.bin
 *   Linux USB cat receipt-80.bin > /dev/usb/lp0
 *
 * If the paper matches SAMPLE-OUTPUT.txt, the renderer and the byte layer are
 * both correct and only the transport remains. If it does not, the difference
 * tells us which vendor quirk to handle.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { renderTicket, toEscPos, kitchenPreset, dispatchPreset, receiptPreset } from '../src/index';
import { order, business, KITCHEN, DISPATCH } from './fixture';

const ESC = 0x1b, GS = 0x1d;

interface Decoded { at: number; name: string; detail: string }

/** Walks the stream. An unknown or truncated sequence throws rather than being
 *  skipped — a decoder that shrugs at a malformed escape is worse than none. */
function decode(buf: Buffer): { commands: Decoded[]; text: string[] } {
  const commands: Decoded[] = [];
  const text: string[] = [];
  let line = '';
  let i = 0;

  const need = (n: number) => {
    if (i + n > buf.length) throw new Error(`truncated escape sequence at offset ${i}`);
  };

  while (i < buf.length) {
    const b = buf[i];

    if (b === ESC) {
      need(2);
      const cmd = buf[i + 1];
      switch (cmd) {
        case 0x40: commands.push({ at: i, name: 'ESC @', detail: 'initialise' }); i += 2; break;
        case 0x74: need(3); commands.push({ at: i, name: 'ESC t', detail: `code page ${buf[i + 2]}` }); i += 3; break;
        case 0x32: commands.push({ at: i, name: 'ESC 2', detail: 'default line spacing' }); i += 2; break;
        case 0x61: need(3); commands.push({ at: i, name: 'ESC a', detail: ['left', 'center', 'right'][buf[i + 2]] ?? `?${buf[i + 2]}` }); i += 3; break;
        case 0x45: need(3); commands.push({ at: i, name: 'ESC E', detail: buf[i + 2] ? 'bold on' : 'bold off' }); i += 3; break;
        case 0x64: need(3); commands.push({ at: i, name: 'ESC d', detail: `feed ${buf[i + 2]} lines` }); i += 3; break;
        case 0x70: need(5); commands.push({ at: i, name: 'ESC p', detail: `drawer pin ${buf[i + 2]}, ${buf[i + 3]}/${buf[i + 4]}` }); i += 5; break;
        default: throw new Error(`unknown ESC command 0x${cmd.toString(16)} at ${i}`);
      }
      continue;
    }

    if (b === GS) {
      need(2);
      const cmd = buf[i + 1];
      switch (cmd) {
        case 0x21: {
          need(3);
          const n = buf[i + 2];
          const w = (n >> 4) + 1, h = (n & 0x0f) + 1;
          commands.push({ at: i, name: 'GS !', detail: `size ${w}x${h}` });
          i += 3;
          break;
        }
        case 0x56: need(4); commands.push({ at: i, name: 'GS V', detail: `cut mode ${buf[i + 2]}, feed ${buf[i + 3]}` }); i += 4; break;
        default: throw new Error(`unknown GS command 0x${cmd.toString(16)} at ${i}`);
      }
      continue;
    }

    if (b === 0x0a) { text.push(line); line = ''; i++; continue; }

    if (b < 0x20 || b > 0x7e) throw new Error(`byte 0x${b.toString(16)} at ${i} is outside the code page`);
    line += String.fromCharCode(b);
    i++;
  }
  if (line.length) text.push(line);
  return { commands, text };
}

const outDir = join(process.cwd(), 'out');
mkdirSync(outDir, { recursive: true });

const targets = [
  ['kitchen-80', kitchenPreset(KITCHEN, 'Kitchen', 80)],
  ['dispatch-80', dispatchPreset(DISPATCH, 'Dispatch', 80)],
  ['receipt-80', receiptPreset('st-till', 'Till', 80)],
  ['kitchen-58', kitchenPreset(KITCHEN, 'Kitchen', 58)],
  ['receipt-58', receiptPreset('st-till', 'Till', 58)],
] as const;

let failures = 0;
const fail = (m: string) => { failures++; console.log(`FAIL  ${m}`); };

for (const [name, station] of targets) {
  const doc = renderTicket({ order, business, station });
  const buf = toEscPos(doc, {
    cut: station.cutPaper,
    openDrawer: station.openCashDrawer,
    feedBeforeCut: station.feedBeforeCut,
  });

  let decoded;
  try {
    decoded = decode(buf);
  } catch (e) {
    fail(`${name}: ${(e as Error).message}`);
    continue;
  }

  const names = decoded.commands.map(c => c.name);
  if (names[0] !== 'ESC @') fail(`${name}: stream does not begin with ESC @`);
  if (names[names.length - 1] !== 'GS V') fail(`${name}: stream does not end with a cut`);

  const widest = Math.max(...decoded.text.map(t => t.length));
  const cols = doc.columns;
  const overflow = decoded.text.filter(t => t.length > cols);
  if (overflow.length) fail(`${name}: ${overflow.length} line(s) exceed ${cols} columns, widest ${widest}`);

  const drawer = names.filter(n => n === 'ESC p').length;
  if (station.openCashDrawer && drawer === 0) fail(`${name}: drawer expected but no ESC p emitted`);
  if (!station.openCashDrawer && drawer > 0) fail(`${name}: drawer pulse emitted for a station that should not open it`);

  writeFileSync(join(outDir, `${name}.bin`), buf);
  console.log(
    `PASS  ${name.padEnd(12)} ${String(buf.length).padStart(5)} bytes  ` +
    `${decoded.commands.length} commands  ${decoded.text.length} lines  widest ${widest}/${cols}`,
  );
}

console.log(`\nRaw streams written to ${outDir}`);
console.log(failures === 0 ? 'Byte stream valid.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
