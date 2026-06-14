import { useState, useRef } from "react";
import { api } from "../../lib/api";
import { usePOSAuth } from "../../context/POSAuthContext";
import { useBusiness } from "../../context/BusinessContext";

interface EODData {
  period: { from: string; to: string };
  branchName: string;
  cashierName: string;
  summary: {
    totalRevenue: number;
    totalOrders: number;
    totalDiscount: number;
    totalVat: number;
    voidedCount: number;
    totalExpenses: number;
    netProfit: number;
  };
  paymentMethods: Record<string, number>;
  topProducts: { name: string; qty: number; revenue: number }[];
  expenses: { total: number; breakdown: { category: string; amount: number }[] };
  shifts?: {
    id: string;
    status: string;
    opening_float: number;
    cash_sales: number;
    float_in: number;
    float_out: number;
    closing_float: number | null;
    expected_cash: number;
    cash_variance: number | null;
  }[];
}

interface Props {
  onClose: () => void;
}

const fmt = (n: number, currency: string) =>
  `${currency} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function ZReportModal({ onClose }: Props) {
  const { session } = usePOSAuth();
  const { business } = useBusiness();
  const currency = (business as any)?.currency ?? "KES";
  const printRef = useRef<HTMLDivElement>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<EODData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manualCash, setManualCash] = useState("");

  const generate = async () => {
    setLoading(true);
    setError("");
    setData(null);
    try {
      const params = new URLSearchParams({ from, to });
      if (session?.branchId) params.set("branch_id", session.branchId);
      const result = await api.get<EODData>(`/api/reports/eod?${params}`);
      setData(result);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load report");
    } finally {
      setLoading(false);
    }
  };

  const print = () => {
    const el = printRef.current;
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`
      <!DOCTYPE html><html><head>
      <title>Z-Report</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; font-size: 12px; padding: 16px; max-width: 380px; margin: 0 auto; }
        .center { text-align: center; }
        .bold { font-weight: bold; }
        .divider { border-top: 1px dashed #000; margin: 8px 0; }
        .row { display: flex; justify-content: space-between; padding: 2px 0; }
        .section-title { font-weight: bold; text-transform: uppercase; font-size: 11px; margin: 8px 0 4px; letter-spacing: 0.05em; }
        .total-row { display: flex; justify-content: space-between; font-weight: bold; font-size: 13px; border-top: 1px solid #000; padding-top: 4px; margin-top: 4px; }
        @media print { body { padding: 0; } }
      </style>
      </head><body>${el.innerHTML}</body></html>
    `);
    w.document.close();
    w.focus();
    setTimeout(() => {
      w.print();
    }, 300);
  };

  const s = data?.summary;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        style={{
          background: "#1e293b",
          border: "1px solid #334155",
          borderRadius: 16,
          width: "100%",
          maxWidth: 500,
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "20px 24px",
            borderBottom: "1px solid #334155",
          }}
        >
          <div>
            <h2 style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 700 }}>
              Z-Report
            </h2>
            <p style={{ color: "#64748b", fontSize: 13, marginTop: 2 }}>
              End-of-day closeout
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              color: "#64748b",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 20,
            }}
          >
            ✕
          </button>
        </div>

        {/* Date picker */}
        <div
          style={{ padding: "20px 24px", borderBottom: "1px solid #334155" }}
        >
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 130 }}>
              <label
                style={{
                  display: "block",
                  color: "#94a3b8",
                  fontSize: 11,
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                From
              </label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                style={{
                  width: "100%",
                  background: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  padding: "8px 12px",
                  color: "#f1f5f9",
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </div>
            <div style={{ flex: 1, minWidth: 130 }}>
              <label
                style={{
                  display: "block",
                  color: "#94a3b8",
                  fontSize: 11,
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                To
              </label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={{
                  width: "100%",
                  background: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  padding: "8px 12px",
                  color: "#f1f5f9",
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </div>
            <button
              onClick={generate}
              disabled={loading}
              style={{
                background: loading ? "#334155" : "#22c55e",
                color: loading ? "#64748b" : "#000",
                border: "none",
                borderRadius: 8,
                padding: "8px 20px",
                fontWeight: 700,
                fontSize: 13,
                cursor: loading ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {loading ? "Loading…" : "Generate"}
            </button>
          </div>
          {error && (
            <p style={{ color: "#f87171", fontSize: 12, marginTop: 8 }}>
              {error}
            </p>
          )}
        </div>

        {/* Report content */}
        {data && (
          <div style={{ padding: "20px 24px" }}>
            {/* Actions */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <button
                onClick={print}
                style={{
                  flex: 1,
                  background: "#0f172a",
                  border: "1px solid #334155",
                  color: "#f1f5f9",
                  borderRadius: 8,
                  padding: "8px 0",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                🖨️ Print
              </button>
            </div>

            {/* Printable receipt */}
            <div
              ref={printRef}
              style={{
                fontFamily: "'Courier New', monospace",
                fontSize: 12,
                maxWidth: 360,
                margin: "0 auto",
              }}
            >
              {/* Business header */}
              <div className="center">
                <p className="bold" style={{ fontSize: 15 }}>
                  {(business as any)?.name ?? "SwiftPOS"}
                </p>
                {data.branchName && <p>{data.branchName}</p>}
                <p style={{ margin: "4px 0" }}>Z-REPORT / END OF DAY</p>
                <p>{new Date().toLocaleString("en-KE")}</p>
              </div>

              <div className="divider" />

              <p className="section-title">Period</p>
              <div className="row">
                <span>From: </span>
                <span>{from}</span>
                <span> </span>
                <span>To: </span>
                <span>{to}</span>
              </div>
              {/* <div className="row">
                <span>To: </span>
                <span>{to}</span>
              </div> */}
              <div className="row">
                <span>Cashier: </span>
                <span>
                  {data.cashierName !== "Unknown"
                    ? data.cashierName
                    : (session?.staffName ?? "Unknown")}
                </span>
              </div>

              <div className="divider" />

              <p className="section-title">Sales Summary</p>
              <div className="row">
                <span>Completed Orders</span>
                <span>{s!.totalOrders}</span>
              </div>
              <div className="row">
                <span>Voided Orders</span>
                <span>{s!.voidedCount}</span>
              </div>
              <div className="row">
                <span>Total Discounts</span>
                <span>- {fmt(s!.totalDiscount, currency)}</span>
              </div>
              <div className="row">
                <span>VAT Collected</span>
                <span>{fmt(s!.totalVat, currency)}</span>
              </div>
              <div className="total-row">
                <span>TOTAL REVENUE</span>
                <span>{fmt(s!.totalRevenue, currency)}</span>
              </div>

              {data.expenses && data.expenses.total > 0 && (
                <>
                  <div className="divider" />
                  <p className="section-title">Expenses</p>
                  {data.expenses.breakdown.map((e, i) => (
                    <div key={i} className="row">
                      <span>{e.category}</span>
                      <span>- {fmt(e.amount, currency)}</span>
                    </div>
                  ))}
                  <div className="row" style={{ fontWeight: 600 }}>
                    <span>Total Expenses</span>
                    <span>- {fmt(s!.totalExpenses, currency)}</span>
                  </div>
                  <div className="total-row" style={{ borderTop: "1px solid #444", marginTop: 4, paddingTop: 4 }}>
                    <span>NET PROFIT</span>
                    <span style={{ color: s!.netProfit >= 0 ? "#4ade80" : "#f87171" }}>
                      {fmt(s!.netProfit, currency)}
                    </span>
                  </div>
                </>
              )}

              <div className="divider" />

              <p className="section-title">Payment Breakdown</p>
              {Object.entries(data.paymentMethods).length === 0 ? (
                <p style={{ color: "#888" }}>No payments</p>
              ) : (
                Object.entries(data.paymentMethods).map(([method, amount]) => (
                  <div key={method} className="row">
                    <span style={{ textTransform: "capitalize" }}>
                      {method}
                    </span>
                    <span>{fmt(amount, currency)}</span>
                  </div>
                ))
              )}

              {/* Cash Reconciliation */}
              {data.shifts && data.shifts.length > 0 && (() => {
                const shift = data.shifts![0];
                const cashSales = shift.cash_sales;
                const expected = shift.expected_cash;
                const counted = parseFloat(manualCash) || 0;
                const variance = counted - expected;
                return (
                  <>
                    <div className="divider" />
                    <p className="section-title">Cash Reconciliation</p>
                    <div className="row"><span>Opening Float</span><span>{fmt(shift.opening_float, currency)}</span></div>
                    <div className="row"><span>Cash Sales</span><span>{fmt(cashSales, currency)}</span></div>
                    {shift.float_in > 0 && (
                      <div className="row"><span>Float In</span><span>{fmt(shift.float_in, currency)}</span></div>
                    )}
                    {shift.float_out > 0 && (
                      <div className="row"><span>Float Out</span><span>-{fmt(shift.float_out, currency)}</span></div>
                    )}
                    <div className="row" style={{ fontWeight: 'bold' }}><span>Expected in Drawer</span><span style={{ color: '#4ade80' }}>{fmt(expected, currency)}</span></div>
                    <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <span style={{ flexShrink: 0 }}>Actual Count</span>
                      <input type="number" step="0.01" value={manualCash}
                        onChange={e => setManualCash(e.target.value)} placeholder="Enter amount"
                        style={{ flex: 1, background: '#0f172a', border: '1px solid #334155', borderRadius: 4,
                          color: '#f1f5f9', fontSize: 11, padding: '3px 6px', textAlign: 'right' }} />
                    </div>
                    {manualCash && (
                      <div className="row" style={{ fontWeight: 'bold', color: Math.abs(variance) < 50 ? '#4ade80' : '#f87171', marginTop: 2 }}>
                        <span>Variance</span>
                        <span>{variance >= 0 ? '+' : ''}{fmt(variance, currency)}</span>
                      </div>
                    )}
                  </>
                );
              })()}

              {data.topProducts.length > 0 && (
                <>
                  <div className="divider" />
                  <p className="section-title">Top Products</p>
                  {data.topProducts.slice(0, 8).map((p, i) => (
                    <div key={i} className="row">
                      <span
                        style={{
                          maxWidth: "55%",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {i + 1}. {p.name}
                      </span>
                      <span>
                        {p.qty}x · {fmt(p.revenue, currency)}
                      </span>
                    </div>
                  ))}
                </>
              )}

              <div className="divider" />
              <div className="center">
                <p>*** END OF Z-REPORT ***</p>
                <p style={{ marginTop: 4, fontSize: 10, color: "#888" }}>
                  Powered by SwiftPOS
                </p>
              </div>
            </div>
          </div>
        )}

        {!data && !loading && (
          <div
            style={{
              padding: 40,
              textAlign: "center",
              color: "#475569",
              fontSize: 13,
            }}
          >
            Select a date range and tap Generate
          </div>
        )}
      </div>
    </div>
  );
}
