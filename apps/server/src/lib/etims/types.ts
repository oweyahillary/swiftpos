// SwiftPOS eTIMS — internal types.
//
// These are OUR types. They are deliberately provider-agnostic: the order flow
// builds an EtimsInvoiceDTO from our own database, and the provider adapter is
// the only place that knows how to translate it into KRA's OSCU/VSCU wire
// format. Swapping mode (OSCU/VSCU) or provider (self vs certified integrator)
// means swapping the adapter only — nothing in the order flow changes.

export type EtimsInvoiceType = 'sale' | 'credit';

export interface EtimsLine {
  name: string;
  quantity: number;
  unitPrice: number;       // VAT-inclusive (our prices include VAT)
  lineTotal: number;       // VAT-inclusive
  taxType: string;         // KRA tax category code (A/B/C/D/E…)
  itemClassCode: string | null;
}

export interface EtimsBranchConfig {
  id: string;
  businessId: string;
  branchId: string;
  environment: 'sandbox' | 'production';
  mode: 'vscu' | 'oscu';
  bhfId: string | null;
  deviceSerial: string | null;
  cmcKey: string | null;
  sdcId: string | null;
  lastInvoiceNo: number;
  status: 'pending' | 'registered' | 'disabled';
}

export interface EtimsInvoiceDTO {
  invoiceType: EtimsInvoiceType;
  invoiceNo: number;             // our per-branch sequential number
  sellerPin: string;             // businesses.tax_pin
  branch: EtimsBranchConfig;
  buyerName: string | null;
  buyerPhone: string | null;
  lines: EtimsLine[];
  subtotal: number;
  vatAmount: number;
  discountAmount: number;
  total: number;
  // For credit notes: identifiers of the original sale.
  originalReceiptNo?: string | null;   // KRA curRcptNo of the original sale
  originalInvoiceNo?: number | null;    // our invoice_no of the original sale (KRA orgInvcNo)
}

// What KRA returns once an invoice is signed.
export interface EtimsSignResult {
  receiptNo: string;             // curRcptNo / rcptNo
  internalData: string;          // intrlData
  signature: string;             // rcptSign
  qrPayload: string;             // content for the receipt QR code
  raw: unknown;                  // full response, persisted for audit
}

export interface EtimsRegisterResult {
  bhfId: string;
  deviceSerial: string;
  cmcKey: string;
  sdcId: string;
  raw: unknown;
}

// The contract every provider adapter must satisfy.
export interface EtimsProvider {
  readonly name: string;
  registerBranch(config: EtimsBranchConfig, sellerPin: string): Promise<EtimsRegisterResult>;
  sendInvoice(dto: EtimsInvoiceDTO): Promise<EtimsSignResult>;
  sendCreditNote(dto: EtimsInvoiceDTO): Promise<EtimsSignResult>;
}

export class EtimsNotConfiguredError extends Error {
  constructor(msg = 'eTIMS provider not configured') { super(msg); this.name = 'EtimsNotConfiguredError'; }
}
