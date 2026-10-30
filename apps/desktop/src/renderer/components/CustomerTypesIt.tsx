/**
 * CustomerTypesIt.tsx — A607: "Customer types it" — for a POS without a customer screen. The cashier's own screen becomes a
 * large, simple form the customer fills in when the screen is turned to them (shared/CustomerAskForm.tsx). While it is
 * shown NOTHING else is: it covers the whole window above every other layer — no menus, no other customers, no cart beyond
 * the bill total, no staff details. "Done" checks what was typed (customerDetails.ts cleanAnswer — only the typed fields)
 * and hands it back to the cashier, who sees it to accept or correct; "Back to the cashier" hands back nothing.
 * Loaded with the panels that open it (never in the POS's main chunk).
 */
import { useMemo } from 'react';
import CustomerAskForm from '../../shared/CustomerAskForm';
import { cleanAnswer, newAskId, type AskPurpose, type CustomerAnswer } from '../../shared/customerDetails';

export default function CustomerTypesIt({ purpose, needPin, amount, currency, onDone, onBack }: {
  purpose: AskPurpose; needPin: boolean; amount: number; currency: string;
  onDone: (a: CustomerAnswer) => void; onBack: () => void;
}) {
  const ask = useMemo(() => ({ id: newAskId(), purpose, needPin: purpose === 'details' && needPin, amount, currency }), [purpose, needPin, amount, currency]);
  return (
    <CustomerAskForm ask={ask} skipLabel="Back to the cashier" style={{ zIndex: 9999 }}
      onSubmit={(v) => {
        const c = cleanAnswer(v, ask);
        if ('errors' in c) return c.errors;
        onDone(c.value);
        return null;
      }}
      onSkip={onBack} />
  );
}
