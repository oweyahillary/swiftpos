// SwiftPOS eTIMS — provider adapter.
//
// getProvider() returns the configured adapter, selected by env so the
// mode/provider decision (SwiftPOS_eTIMS_Integration_Scope.md §2) never touches
// the order flow:
//   ETIMS_PROVIDER = 'none'  -> NullProvider (default; nothing transmitted)
//   ETIMS_PROVIDER = 'vscu'  -> VscuProvider (reference implementation below)
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  REFERENCE IMPLEMENTATION — VERIFY AGAINST SANDBOX BEFORE PRODUCTION       ║
// ║                                                                            ║
// ║  The payload below is built from KRA's PUBLICLY DOCUMENTED OSCU/VSCU v2.0  ║
// ║  field names (tin, bhfId, invcNo, rcptTyCd, taxTyCd, itemList, curRcptNo,  ║
// ║  intrlData, rcptSign…) and open-source integrations. It is NOT guessed —   ║
// ║  but it is also NOT yet confirmed against a live KRA sandbox. Before going ║
// ║  live you MUST verify, against the OSCU/VSCU v2.0 spec + sandbox:          ║
// ║   • endpoint paths + auth mechanism (self vs integrator differ)            ║
// ║   • code enums: salesTyCd / rcptTyCd / pmtTyCd / salesSttsCd               ║
// ║   • tax-type rates (TAX_RATES below) and rounding rules                    ║
// ║   • the QR payload/URL format                                              ║
// ║   • that every product carries a REAL KRA itemClsCd                        ║
// ║  Specs: OSCU v2.0 / VSCU v2.0 PDFs on kra.go.ke                            ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import type {
  EtimsProvider, EtimsInvoiceDTO, EtimsSignResult, EtimsBranchConfig, EtimsRegisterResult, EtimsLine,
} from './types';
import { EtimsNotConfiguredError } from './types';

// ── Config (all overridable via env to match the chosen provider/mode) ───────
const BASE_URL    = process.env.ETIMS_BASE_URL ?? '';
const AUTH_TOKEN  = process.env.ETIMS_AUTH_TOKEN ?? '';            // integrator bearer (optional)
const SALES_PATH  = process.env.ETIMS_SALES_PATH ?? '/saveTrnsSalesOsdc';
const INIT_PATH   = process.env.ETIMS_INIT_PATH  ?? '/selectInitOsdcInfo';
const QR_BASE     = process.env.ETIMS_QR_BASE ?? 'https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=';

// KRA tax-type code -> VAT rate (%). VERIFY against the current spec — rates and
// the meaning of each code can change with the Finance Act.
const TAX_RATES: Record<string, number> = {
  A: 0,   // Exempt
  B: 16,  // Standard rate
  C: 0,   // Zero-rated
  D: 0,   // Non-VAT
  E: 8,   // (historically fuel/other reduced rate)
};

// ── Date/number helpers (KRA expects yyyyMMddHHmmss and yyyyMMdd) ─────────────
const pad = (n: number) => String(n).padStart(2, '0');
function stampDateTime(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function stampDate(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── NullProvider — safe default ──────────────────────────────────────────────
class NullProvider implements EtimsProvider {
  readonly name = 'none';
  async registerBranch(): Promise<EtimsRegisterResult> { throw new EtimsNotConfiguredError(); }
  async sendInvoice(): Promise<EtimsSignResult> { throw new EtimsNotConfiguredError(); }
  async sendCreditNote(): Promise<EtimsSignResult> { throw new EtimsNotConfiguredError(); }
}

// ── VscuProvider — reference implementation ──────────────────────────────────
class VscuProvider implements EtimsProvider {
  readonly name = 'vscu';

  private headers(branch: EtimsBranchConfig, sellerPin: string): Record<string, string> {
    // KRA-native style carries device context in the body; integrators often add
    // a bearer token. We send both styles so either provider works; trim to suit.
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    if (sellerPin) h['tin'] = sellerPin;
    if (branch.bhfId) h['bhfId'] = branch.bhfId;
    if (branch.cmcKey) h['cmcKey'] = branch.cmcKey;
    return h;
  }

  private async post(path: string, headers: Record<string, string>, body: unknown): Promise<any> {
    if (!BASE_URL) throw new EtimsNotConfiguredError('ETIMS_BASE_URL not set');
    const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json: any = await res.json().catch(() => ({}));
    // KRA envelope: { resultCd, resultMsg, resultDt, data }. '000' = success.
    if (!res.ok || (json.resultCd && json.resultCd !== '000')) {
      throw new Error(`eTIMS ${path} -> ${json.resultCd ?? res.status}: ${json.resultMsg ?? res.statusText}`);
    }
    return json;
  }

  // Per-tax-type taxable/tax breakdown. Prices are VAT-INCLUSIVE, so for a rated
  // bucket: taxable = gross / (1+rate), tax = gross - taxable.
  private taxBreakdown(lines: EtimsLine[]) {
    const buckets = ['A', 'B', 'C', 'D', 'E'];
    const taxbl: Record<string, number> = {}; const tax: Record<string, number> = {};
    buckets.forEach((b) => { taxbl[b] = 0; tax[b] = 0; });
    for (const l of lines) {
      const code = TAX_RATES[l.taxType] !== undefined ? l.taxType : 'B';
      const rate = TAX_RATES[code];
      const gross = l.lineTotal;
      const taxable = rate > 0 ? gross / (1 + rate / 100) : gross;
      taxbl[code] += taxable;
      tax[code]  += gross - taxable;
    }
    buckets.forEach((b) => { taxbl[b] = r2(taxbl[b]); tax[b] = r2(tax[b]); });
    return { taxbl, tax };
  }

  private buildItemList(lines: EtimsLine[]) {
    return lines.map((l, i) => {
      const code = TAX_RATES[l.taxType] !== undefined ? l.taxType : 'B';
      const rate = TAX_RATES[code];
      const gross = r2(l.lineTotal);
      const taxable = r2(rate > 0 ? gross / (1 + rate / 100) : gross);
      return {
        itemSeq:   i + 1,
        itemCd:    null,                      // optional registered item code
        itemClsCd: l.itemClassCode ?? '',     // REQUIRED real KRA classification code
        itemNm:    l.name,
        bcd:       null,
        pkgUnitCd: 'NT',                      // packaging unit — VERIFY enum
        pkg:       1,
        qtyUnitCd: 'U',                       // quantity unit — VERIFY enum
        qty:       l.quantity,
        prc:       r2(l.unitPrice),
        splyAmt:   gross,
        dcRt:      0,
        dcAmt:     0,
        taxTyCd:   code,
        taxblAmt:  taxable,
        taxAmt:    r2(gross - taxable),
        totAmt:    gross,
      };
    });
  }

  private buildSalePayload(dto: EtimsInvoiceDTO, rcptTyCd: 'S' | 'R') {
    const { taxbl, tax } = this.taxBreakdown(dto.lines);
    const now = new Date();
    return {
      tin:        dto.sellerPin,
      bhfId:      dto.branch.bhfId ?? '00',
      invcNo:     dto.invoiceNo,
      orgInvcNo:  rcptTyCd === 'R' ? (dto.originalInvoiceNo ?? 0) : 0,
      custTin:    null,
      custNm:     dto.buyerName ?? null,
      salesTyCd:  'N',                         // Normal — VERIFY enum
      rcptTyCd,                                // 'S' sale, 'R' credit/refund — VERIFY
      pmtTyCd:    '01',                        // payment type — VERIFY enum
      salesSttsCd:'02',                        // approved — VERIFY enum
      cfmDt:      stampDateTime(now),
      salesDt:    stampDate(now),
      stockRlsDt: stampDateTime(now),
      totItemCnt: dto.lines.length,
      taxblAmtA: taxbl.A, taxblAmtB: taxbl.B, taxblAmtC: taxbl.C, taxblAmtD: taxbl.D, taxblAmtE: taxbl.E,
      taxRtA: TAX_RATES.A, taxRtB: TAX_RATES.B, taxRtC: TAX_RATES.C, taxRtD: TAX_RATES.D, taxRtE: TAX_RATES.E,
      taxAmtA: tax.A, taxAmtB: tax.B, taxAmtC: tax.C, taxAmtD: tax.D, taxAmtE: tax.E,
      totTaxblAmt: r2(dto.total),
      totTaxAmt:   r2(dto.vatAmount),
      totAmt:      r2(dto.total),
      prchrAcptcYn: 'N',
      remark:     null,
      regrId:     'SwiftPOS', regrNm: 'SwiftPOS',
      modrId:     'SwiftPOS', modrNm: 'SwiftPOS',
      receipt: {
        custTin:    null,
        custMblNo:  dto.buyerPhone ?? null,
        rptNo:      dto.invoiceNo,
        trdeNm:     null,
        adrs:       null,
        prchrAcptcYn: 'N',
      },
      itemList: this.buildItemList(dto.lines),
    };
  }

  private parseSignResult(json: any): EtimsSignResult {
    const d = json.data ?? json;
    const receiptNo = String(d.curRcptNo ?? d.rcptNo ?? '');
    const signature = String(d.rcptSign ?? '');
    return {
      receiptNo,
      internalData: String(d.intrlData ?? ''),
      signature,
      // VERIFY exact QR format — commonly the receipt-verification URL keyed by signature.
      qrPayload: `${QR_BASE}${signature}`,
      raw: json,
    };
  }

  async registerBranch(config: EtimsBranchConfig, sellerPin: string): Promise<EtimsRegisterResult> {
    const body = { tin: sellerPin, bhfId: config.bhfId ?? '00', dvcSrlNo: config.deviceSerial ?? '' };
    const json = await this.post(INIT_PATH, this.headers(config, sellerPin), body);
    const d = json.data?.info ?? json.data ?? {};
    return {
      bhfId:        String(d.bhfId ?? config.bhfId ?? '00'),
      deviceSerial: String(d.dvcSrlNo ?? config.deviceSerial ?? ''),
      cmcKey:       String(d.cmcKey ?? ''),
      sdcId:        String(d.sdcId ?? ''),
      raw: json,
    };
  }

  async sendInvoice(dto: EtimsInvoiceDTO): Promise<EtimsSignResult> {
    const json = await this.post(SALES_PATH, this.headers(dto.branch, dto.sellerPin), this.buildSalePayload(dto, 'S'));
    return this.parseSignResult(json);
  }

  async sendCreditNote(dto: EtimsInvoiceDTO): Promise<EtimsSignResult> {
    const json = await this.post(SALES_PATH, this.headers(dto.branch, dto.sellerPin), this.buildSalePayload(dto, 'R'));
    return this.parseSignResult(json);
  }
}

let _provider: EtimsProvider | null = null;

export function getProvider(): EtimsProvider {
  if (_provider) return _provider;
  switch ((process.env.ETIMS_PROVIDER ?? 'none').toLowerCase()) {
    case 'vscu': _provider = new VscuProvider(); break;
    // case 'integrator': _provider = new IntegratorProvider(); break;
    default:     _provider = new NullProvider();
  }
  return _provider;
}

export function etimsEnabledGlobally(): boolean {
  return (process.env.ETIMS_PROVIDER ?? 'none').toLowerCase() !== 'none';
}
