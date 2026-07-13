/**
 * QRMenuPage.tsx
 * Route: /menu/:slug  (PUBLIC — no auth required)
 *
 * Guest-facing menu page loaded via QR code at the table.
 * Guests browse categories, add items to cart, and submit order.
 * Order lands in KDS as an open order for the table.
 */

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { API_URL } from '../lib/config';
const API = API_URL;

interface Business { id: string; name: string; currency: string; }
interface Category  { id: string; name: string; sort_order: number; }
interface Product   { id: string; name: string; description: string | null; price: number; image_url: string | null; category_id: string | null; }
interface CartItem  { product: Product; quantity: number; notes: string; }

function fmt(currency: string, n: number) {
  return `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
}

export default function QRMenuPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const tableId   = searchParams.get('table') ?? '';

  const [business,    setBusiness]   = useState<Business | null>(null);
  const [categories,  setCats]       = useState<Category[]>([]);
  const [products,    setProducts]   = useState<Product[]>([]);
  const [tableName,   setTableName]  = useState<string | null>(null);
  const [branchId,    setBranchId]   = useState<string>('');
  const [loading,     setLoading]    = useState(true);
  const [error,       setError]      = useState('');
  const [cart,        setCart]       = useState<CartItem[]>([]);
  const [activecat,   setActiveCat]  = useState('');
  const [guestName,   setGuestName]  = useState('');
  const [showCart,    setShowCart]   = useState(false);
  const [submitting,  setSubmitting] = useState(false);
  const [orderDone,   setOrderDone]  = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    const params = new URLSearchParams();
    if (tableId) params.set('table_id', tableId);

    fetch(`${API}/api/qr/${slug}/menu?${params}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); return; }
        setBusiness(data.business);
        setCats(data.categories);
        setProducts(data.products);
        setTableName(data.table_name);
        setBranchId(data.branch_id ?? '');
        if (data.categories.length) setActiveCat(data.categories[0].id);
      })
      .catch(() => setError('Could not load menu. Please try again.'))
      .finally(() => setLoading(false));
  }, [slug, tableId]); // eslint-disable-line

  function addToCart(product: Product) {
    setCart(c => {
      const existing = c.find(i => i.product.id === product.id);
      if (existing) return c.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...c, { product, quantity: 1, notes: '' }];
    });
  }

  function updateQty(productId: string, qty: number) {
    if (qty <= 0) { setCart(c => c.filter(i => i.product.id !== productId)); return; }
    setCart(c => c.map(i => i.product.id === productId ? { ...i, quantity: qty } : i));
  }

  function cartQty(productId: string) { return cart.find(i => i.product.id === productId)?.quantity ?? 0; }

  const cartTotal = cart.reduce((s, i) => s + i.product.price * i.quantity, 0);
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);

  async function submitOrder() {
    if (cart.length === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/qr/${slug}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: tableId || null,
          branch_id: branchId,
          guest_name: guestName.trim() || null,
          items: cart.map(i => ({ product_id: i.product.id, quantity: i.quantity, notes: i.notes || null })),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setOrderDone(data.order_number);
      setCart([]);
      setShowCart(false);
    } catch (e: any) {
      setError(e.message ?? 'Failed to place order. Please ask staff for help.');
    } finally { setSubmitting(false); }
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-gray-700 border-t-green-500 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-gray-500 text-sm">Loading menu…</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="text-center max-w-xs">
        <p className="text-4xl mb-3">😕</p>
        <p className="text-white font-semibold mb-1">Menu unavailable</p>
        <p className="text-gray-500 text-sm">{error}</p>
      </div>
    </div>
  );

  if (orderDone) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="text-center max-w-xs">
        <p className="text-5xl mb-4">✅</p>
        <p className="text-white font-bold text-xl mb-2">Order placed!</p>
        <p className="text-gray-400 text-sm mb-1">Your order <strong className="text-white">{orderDone}</strong> has been sent to the kitchen.</p>
        <p className="text-gray-600 text-xs">A team member will be with you shortly.</p>
        <button onClick={() => setOrderDone(null)}
          className="mt-6 px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-xl text-sm transition-colors">
          Order more
        </button>
      </div>
    </div>
  );

  const visibleProducts = products.filter(p => p.category_id === activecat);

  return (
    <div className="min-h-screen bg-gray-950 text-white pb-28">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-5 py-4 sticky top-0 z-20">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div>
            <p className="font-bold text-lg">{business?.name}</p>
            {tableName && <p className="text-gray-500 text-xs">Table {tableName}</p>}
          </div>
          {cartCount > 0 && (
            <button onClick={() => setShowCart(true)}
              className="flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors">
              🛒 <span>{cartCount}</span>
              <span className="hidden sm:inline">·</span>
              <span className="hidden sm:inline">{fmt(business?.currency ?? 'KES', cartTotal)}</span>
            </button>
          )}
        </div>
      </div>

      {/* Category tabs */}
      <div className="bg-gray-900/50 border-b border-gray-800 sticky top-[65px] z-10 overflow-x-auto">
        <div className="max-w-lg mx-auto flex gap-1 px-4 py-2">
          {categories.map(cat => (
            <button key={cat.id} onClick={() => setActiveCat(cat.id)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                activecat === cat.id ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}>
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* Products */}
      <div className="max-w-lg mx-auto px-4 py-5 space-y-3">
        {visibleProducts.length === 0 && (
          <div className="text-center py-10 text-gray-600 text-sm">No items in this category.</div>
        )}
        {visibleProducts.map(p => {
          const qty = cartQty(p.id);
          return (
            <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden flex">
              {p.image_url && (
                <img src={p.image_url} alt={p.name} className="w-24 h-24 object-cover flex-shrink-0" />
              )}
              <div className="flex-1 p-4 flex flex-col justify-between">
                <div>
                  <p className="text-white font-semibold">{p.name}</p>
                  {p.description && <p className="text-gray-500 text-xs mt-0.5 line-clamp-2">{p.description}</p>}
                </div>
                <div className="flex items-center justify-between mt-3">
                  <p className="text-green-400 font-bold">{fmt(business?.currency ?? 'KES', p.price)}</p>
                  {qty === 0 ? (
                    <button onClick={() => addToCart(p)}
                      className="px-4 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm font-semibold rounded-xl transition-colors">
                      Add
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => updateQty(p.id, qty - 1)}
                        className="w-8 h-8 bg-gray-800 hover:bg-gray-700 text-white rounded-lg text-lg flex items-center justify-center">−</button>
                      <span className="text-white font-bold w-5 text-center">{qty}</span>
                      <button onClick={() => updateQty(p.id, qty + 1)}
                        className="w-8 h-8 bg-green-600 hover:bg-green-500 text-white rounded-lg text-lg flex items-center justify-center">+</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Cart button fixed bottom */}
      {cartCount > 0 && !showCart && (
        <div className="fixed bottom-6 left-0 right-0 flex justify-center z-30 px-6">
          <button onClick={() => setShowCart(true)}
            className="w-full max-w-lg bg-green-600 hover:bg-green-500 text-white font-bold py-4 rounded-2xl shadow-2xl flex items-center justify-between px-6 transition-colors">
            <span className="bg-green-800/50 text-white text-xs font-bold w-6 h-6 rounded-lg flex items-center justify-center">{cartCount}</span>
            <span>View order</span>
            <span>{fmt(business?.currency ?? 'KES', cartTotal)}</span>
          </button>
        </div>
      )}

      {/* Cart modal */}
      {showCart && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-end">
          <div className="bg-gray-900 border-t border-gray-800 rounded-t-3xl w-full max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800">
              <h2 className="text-white font-bold text-lg">Your order</h2>
              <button onClick={() => setShowCart(false)} className="text-gray-500 hover:text-white text-xl">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {cart.map(i => (
                <div key={i.product.id} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{i.product.name}</p>
                    <p className="text-gray-500 text-xs">{fmt(business?.currency ?? 'KES', i.product.price)} each</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => updateQty(i.product.id, i.quantity - 1)}
                      className="w-7 h-7 bg-gray-800 hover:bg-gray-700 text-white rounded-lg text-base flex items-center justify-center">−</button>
                    <span className="text-white text-sm font-bold w-4 text-center">{i.quantity}</span>
                    <button onClick={() => updateQty(i.product.id, i.quantity + 1)}
                      className="w-7 h-7 bg-gray-800 hover:bg-gray-700 text-white rounded-lg text-base flex items-center justify-center">+</button>
                  </div>
                  <span className="text-white text-sm font-medium w-20 text-right">
                    {fmt(business?.currency ?? 'KES', i.product.price * i.quantity)}
                  </span>
                </div>
              ))}
              <div className="border-t border-gray-800 pt-3 flex justify-between text-sm font-bold">
                <span className="text-gray-400">Total</span>
                <span className="text-white">{fmt(business?.currency ?? 'KES', cartTotal)}</span>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Your name (optional)</label>
                <input value={guestName} onChange={e => setGuestName(e.target.value)} placeholder="e.g. Kizzy"
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-green-500" />
              </div>
            </div>
            <div className="px-6 py-5 border-t border-gray-800">
              <button onClick={submitOrder} disabled={submitting || cart.length === 0}
                className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white font-bold py-4 rounded-2xl text-base transition-colors">
                {submitting ? 'Sending to kitchen…' : `Place order · ${fmt(business?.currency ?? 'KES', cartTotal)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
