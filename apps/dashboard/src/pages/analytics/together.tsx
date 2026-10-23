/**
 * together.tsx — A575: "What sells together" on the Analytics page.
 *
 * The owner's backlog: which products end up in the same order, said plainly, and what to do about it — stock them
 * together, put them side by side, offer one with the other, make a combo. Never a price ("prices should be
 * competitive"), never a KES gain: only what customers already did.
 *
 * The cloud works it out (GET /api/analytics/together, migration 164's analytics_together; the ranking and the words in
 * apps/server/src/lib/analyticsRules.ts summariseTogether, the advice in analyticsTerms.ts togetherAdvice for the
 * business's own way of selling). This draws the top 10: the sentence ("People who buy Chicken Wrap often add Soda 500ml
 * (38 of 120 orders with Chicken Wrap)"), how often as a bar, and what to do in a few words. Too few orders with two or
 * more items (under 30): a friendly note instead.
 */
import * as fmt from '../../lib/format';
import type { ChartPalette } from './chartPalette';

export interface TogetherAdviceLine { title: string; action: string; short: string }
export interface TogetherPairLine {
  aId: string; aName: string; aFuel: boolean; aOrders: number;
  bId: string; bName: string; bFuel: boolean; bOrders: number;
  together: number; share: number; lift: number; sentence: string; advice: TogetherAdviceLine;
}
export interface TogetherAnswer {
  orders: number; multiOrders: number; enough: boolean; note: string | null;
  pairs: TogetherPairLine[]; total: number; businessType?: string | null;
}

/** The share as a whole percent, never "0%" for a real pair. */
export const sharePct = (x: number) => `${Math.max(1, Math.round(x * 100))}%`;

export function TogetherSection({ t, p }: { t: TogetherAnswer; p: ChartPalette }) {
  return (
    <div className="space-y-3" data-testid="analytics-together">
      <div>
        <h2 className="text-lg font-bold text-white">What sells together</h2>
        <p className="text-sm text-gray-400">Products customers buy in the same order — keep them in stock together, put them where one leads to the other, and remind cashiers to offer the second.</p>
      </div>
      {!t.enough || t.pairs.length === 0 ? (
        <p className="text-sm text-gray-400 bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="analytics-together-empty">
          {t.note ?? 'Nothing to show yet.'}
        </p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <ol className="divide-y divide-gray-800" data-testid="analytics-together-list">
            {t.pairs.map((x, i) => (
              <li key={`${x.aId}.${x.bId}`} className="p-3 sm:px-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 min-w-0">
                <span className="hidden sm:flex w-6 h-6 rounded-full bg-gray-800 text-gray-300 text-xs font-bold items-center justify-center flex-shrink-0" aria-hidden>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white leading-snug">
                    <span className="font-semibold">{x.aName}</span>
                    <span className="text-gray-400"> + </span>
                    <span className="font-semibold">{x.bName}</span>
                  </p>
                  <p className="text-xs text-gray-400 leading-snug mt-0.5">{x.sentence}.</p>
                </div>
                <div className="sm:w-44 flex-shrink-0" title={`${fmt.num(x.together)} of ${fmt.num(x.aOrders)} orders with ${x.aName}`}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-gray-500 truncate min-w-0">Of the {x.aName} orders</span>
                    <span className="text-white font-semibold tabular-nums">{sharePct(x.share)}</span>
                  </div>
                  <div className="h-1.5 rounded-full mt-1" style={{ background: p.grid }} aria-hidden>
                    <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, Math.max(3, x.share * 100))}%`, background: p.accent }} />
                  </div>
                </div>
                <p className="text-xs font-semibold text-swift-text sm:w-48 flex-shrink-0" data-testid="analytics-together-do">{x.advice.short}</p>
              </li>
            ))}
          </ol>
          {t.total > t.pairs.length && (
            <p className="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-800" data-testid="analytics-cap">
              Showing the top {t.pairs.length} of {t.total}, the pairs that go together most first.
            </p>
          )}
        </div>
      )}
      {t.enough && (
        <p className="text-[11px] text-gray-500">
          From {fmt.num(t.multiOrders)} orders with two or more items (of {fmt.num(t.orders)}). A pair is listed when it is in at least 5
          orders and turns up together more often than chance would put it there; an item rung twice counts once, and free
          lines and add-ons are left out.
        </p>
      )}
    </div>
  );
}
