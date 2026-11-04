/**
 * BillSplit — split the bill between people, on both payment screens (owner decision 2026-11-04,
 * docs/POS-SCREEN-COMPARISON.html): evenly per person ("4 people" — four equal parts), or by item per guest (each guest
 * pays for what they had; offered when the bill has two lines or more). The shares always add up to the bill exactly
 * (@zaptill/core/tender evenShares / itemShares: the cloud refuses legs that do not).
 *
 * This piece is the choosing — the way, the number of people, which guest had which line — and the shares. What is done
 * with them is the screen's (`children`): the desktop turns them into payments on its payment screen (each any method,
 * the M-Pesa prompt included); the web asks each person's method below them and charges.
 *
 * Each app passes its look (./paint.ts).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { evenShares, itemShares, itemSplitReady, round2 } from '@zaptill/core/tender';
import { painted, type Paint } from './paint';

export type SplitWay = 'even' | 'items';

/** One person's part of the bill. */
export interface BillShare {
  /** "Person 1" / "Guest 2". */
  who: string;
  amount: number;
}

/** A line of the bill, for the by-item split. */
export interface BillLine {
  name: string;
  qty: number;
  /** The line's total. */
  amount: number;
}

export interface BillSplitLook {
  box: Paint;
  ways: Paint;
  way: (chosen: boolean) => Paint;
  stepRow: Paint;
  stepLabel: Paint;
  stepper: Paint;
  stepButton: Paint;
  count: Paint;
  hint: Paint;
  lines: Paint;
  line: Paint;
  lineHead: Paint;
  lineName: Paint;
  lineAmount: Paint;
  guests: Paint;
  guest: (chosen: boolean) => Paint;
}

const MAX_PEOPLE = 12;
const MAX_GUESTS = 6;

export default function BillSplit({ total, lines = [], initialWay = 'even', format, look, children }: {
  /** What the shares add up to (the bill with the tip and any fee: what is collected). */
  total: number;
  lines?: BillLine[];
  initialWay?: SplitWay;
  format: (n: number) => string;
  look: BillSplitLook;
  /** What the screen does with the shares; `ready` = they may be charged. */
  children: (shares: BillShare[], ready: boolean, way: SplitWay) => ReactNode;
}) {
  const byItemOffered = lines.length >= 2;
  const [way, setWay] = useState<SplitWay>(initialWay === 'items' && byItemOffered ? 'items' : 'even');
  const [people, setPeople] = useState(2);
  const [guests, setGuests] = useState(2);
  // assign[i]: the guest line i is on (all on guest 1 to start).
  const [assign, setAssign] = useState<number[]>(() => lines.map(() => 0));

  const changeGuests = (n: number) => {
    const next = Math.max(2, Math.min(MAX_GUESTS, n));
    setGuests(next);
    setAssign((prev) => prev.map((g) => (g >= next ? 0 : g)));   // a removed guest's lines go back to guest 1
  };

  const { shares, ready } = useMemo(() => {
    if (way === 'even') {
      const amounts = evenShares(total, people);
      return { shares: amounts.map((amount, i) => ({ who: `Person ${i + 1}`, amount })), ready: total > 0 };
    }
    const amounts = itemShares(lines.map((l) => l.amount), assign, guests, total);
    return { shares: amounts.map((amount, g) => ({ who: `Guest ${g + 1}`, amount })), ready: itemSplitReady(amounts, total) };
  }, [way, total, people, guests, assign, lines]);

  const count = way === 'even' ? people : guests;
  const setCount = way === 'even' ? (n: number) => setPeople(Math.max(2, Math.min(MAX_PEOPLE, n))) : changeGuests;
  const max = way === 'even' ? MAX_PEOPLE : MAX_GUESTS;
  const even = evenShares(total, people);
  const rounding = round2(even[0] - even[even.length - 1]);

  return (
    <div {...painted(look.box)} data-testid="bill-split">
      {byItemOffered && (
        <div {...painted(look.ways)} role="tablist" aria-label="Split the bill">
          <button type="button" role="tab" aria-selected={way === 'even'} onClick={() => setWay('even')} {...painted(look.way(way === 'even'))}>Evenly</button>
          <button type="button" role="tab" aria-selected={way === 'items'} onClick={() => setWay('items')} data-testid="split-by-item" {...painted(look.way(way === 'items'))}>By item</button>
        </div>
      )}
      <div {...painted(look.stepRow)}>
        <span {...painted(look.stepLabel)}>{way === 'even' ? 'People' : 'Guests'}</span>
        <div {...painted(look.stepper)}>
          <button type="button" aria-label="One fewer" disabled={count <= 2} onClick={() => setCount(count - 1)} {...painted(look.stepButton)}>−</button>
          <span {...painted(look.count)} data-testid="split-count">{count}</span>
          <button type="button" aria-label="One more" disabled={count >= max} onClick={() => setCount(count + 1)} {...painted(look.stepButton)}>+</button>
        </div>
      </div>
      {way === 'even' ? (
        <p {...painted(look.hint)}>
          {format(even[even.length - 1])} each{rounding > 0 ? ` · person 1 pays ${format(even[0])} (rounding)` : ''}
        </p>
      ) : (
        <div {...painted(look.lines)}>
          {lines.map((l, i) => (
            <div key={i} {...painted(look.line)}>
              <div {...painted(look.lineHead)}>
                <span {...painted(look.lineName)}>{l.qty}× {l.name}</span>
                <span {...painted(look.lineAmount)}>{format(l.amount)}</span>
              </div>
              <div {...painted(look.guests)}>
                {Array.from({ length: guests }, (_, g) => (
                  <button key={g} type="button" aria-pressed={assign[i] === g} onClick={() => setAssign((prev) => prev.map((x, idx) => (idx === i ? g : x)))}
                    {...painted(look.guest(assign[i] === g))}>
                    G{g + 1}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {children(shares, ready, way)}
    </div>
  );
}
