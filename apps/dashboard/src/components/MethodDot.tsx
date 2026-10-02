import { methodColour } from '../lib/paymentColours';

/** A344: the payment method's colour, as a small dot beside its name (the name keeps the normal text colour). */
export default function MethodDot({ method }: { method: string | null | undefined }) {
  return (
    <span aria-hidden data-method-dot={String(method ?? '')}
      style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: methodColour(method).dot, marginRight: 6, verticalAlign: 'middle' }} />
  );
}
