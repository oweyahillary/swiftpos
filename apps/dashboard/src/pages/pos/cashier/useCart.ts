/**
 * useCart — all cart state and mutations for the POS.
 *
 * Extracted from CashierScreen to isolate the 30+ state variables and
 * callback functions related to the active order / cart.
 *
 * Stable references via useCallback — only the relevant state slices
 * re-render their consumers, not the entire CashierScreen tree.
 */

import { useState, useCallback } from 'react';
import type { CartItem, Product, VariantGroup, VariantOption } from './types';

export interface CartActions {
  // Cart contents
  cart:            CartItem[];
  setCart:         React.Dispatch<React.SetStateAction<CartItem[]>>;
  addToCart:       (product: Product, variantsByProduct: Record<string, VariantGroup[]>) => void;
  addFuelToCart:   (product: Product, litres: number, amount: number) => void;
  updateQty:       (index: number, delta: number) => void;
  removeItem:      (index: number) => void;
  setItemCourse:   (index: number, course: string) => void;
  toggleItemHold:  (index: number) => void;
  clearCart:       () => void;

  // Minimart adapters
  minimartAddToCart:   (product: Product, qty?: number) => void;
  minimartUpdateQty:   (productId: string, delta: number) => void;
  minimartRemoveItem:  (productId: string) => void;

  // Variant modal state
  variantProduct:      Product | null;
  selectedVariants:    Record<string, VariantOption>;
  openVariantModal:    (product: Product) => void;
  closeVariantModal:   () => void;
  toggleVariantOption: (group: VariantGroup, option: VariantOption) => void;
  confirmVariants:     (modifiers: { id: string; name: string; price: number }[]) => void;

  // Fuel modal state
  fuelEntry:       Product | null;
  setFuelEntry:    (p: Product | null) => void;
  fuelEdited:      'amount' | 'litres';
  setFuelEdited:   (v: 'amount' | 'litres') => void;
  fuelAmountStr:   string;
  setFuelAmountStr:(v: string) => void;
  fuelLitresStr:   string;
  setFuelLitresStr:(v: string) => void;
}

export function useCart(): CartActions {
  const [cart, setCart] = useState<CartItem[]>([]);

  // Variant modal
  const [variantProduct,   setVariantProduct]   = useState<Product | null>(null);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, VariantOption>>({});

  // Fuel modal
  const [fuelEntry,        setFuelEntry]        = useState<Product | null>(null);
  const [fuelEdited,       setFuelEdited]       = useState<'amount' | 'litres'>('amount');
  const [fuelAmountStr,    setFuelAmountStr]    = useState('');
  const [fuelLitresStr,    setFuelLitresStr]    = useState('');

  // ── Core add ─────────────────────────────────────────────────────────────
  const addToCart = useCallback((
    product: Product,
    variantsByProduct: Record<string, VariantGroup[]>,
  ) => {
    if ((product as any).is_fuel) {
      setFuelEntry(product);
      setFuelEdited('amount');
      setFuelAmountStr('');
      setFuelLitresStr('');
      return;
    }
    const groups = variantsByProduct[product.id] ?? [];
    if (product.has_variants && groups.length > 0) {
      setVariantProduct(product);
      setSelectedVariants({});
      return;
    }
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id && i.selectedVariants.length === 0);
      if (existing) {
        return prev.map(i => i === existing
          ? { ...i, quantity: i.quantity + 1, lineTotal: i.unitPrice * (i.quantity + 1) }
          : i
        );
      }
      return [...prev, {
        product,
        quantity: 1,
        selectedVariants: [],
        selectedModifiers: [],
        unitPrice: Number(product.base_price),
        lineTotal: Number(product.base_price),
      }];
    });
  }, []);

  const addFuelToCart = useCallback((product: Product, litres: number, amount: number) => {
    setCart(prev => [...prev, {
      product,
      quantity: litres,
      selectedVariants: [],
      selectedModifiers: [],
      unitPrice: Number(product.base_price),
      lineTotal: amount,
      isFuel: true,
    }]);
    setFuelEntry(null);
  }, []);

  const updateQty = useCallback((index: number, delta: number) => {
    setCart(prev =>
      prev
        .map((item, i) => {
          if (i !== index) return item;
          const newQty = item.quantity + delta;
          return { ...item, quantity: newQty, lineTotal: item.unitPrice * newQty };
        })
        .filter(item => item.quantity > 0)
    );
  }, []);

  const removeItem = useCallback((index: number) => {
    setCart(prev => prev.filter((_, i) => i !== index));
  }, []);

  const setItemCourse = useCallback((index: number, course: string) => {
    setCart(prev => prev.map((it, i) => i === index
      ? { ...it, course: course || null, fire_status: course ? (it.fire_status ?? 'held') : 'fired' }
      : it
    ));
  }, []);

  const toggleItemHold = useCallback((index: number) => {
    setCart(prev => prev.map((it, i) => i === index
      ? { ...it, fire_status: it.fire_status === 'held' ? 'fired' : 'held' }
      : it
    ));
  }, []);

  const clearCart = useCallback(() => setCart([]), []);

  // ── Variant modal ─────────────────────────────────────────────────────────
  const openVariantModal  = useCallback((product: Product) => {
    setVariantProduct(product);
    setSelectedVariants({});
  }, []);

  const closeVariantModal = useCallback(() => {
    setVariantProduct(null);
    setSelectedVariants({});
  }, []);

  const toggleVariantOption = useCallback((group: VariantGroup, option: VariantOption) => {
    setSelectedVariants(prev => ({ ...prev, [group.id]: option }));
  }, []);

  const confirmVariants = useCallback((
    modifiers: { id: string; name: string; price: number }[],
  ) => {
    if (!variantProduct) return;
    const variants = Object.values(selectedVariants);
    const priceAdj = variants.reduce((s, v) => s + Number(v.price_adjustment ?? 0), 0);
    const modAdj   = modifiers.reduce((s, m) => s + Number(m.price ?? 0), 0);
    const basePrice = Number(variantProduct.base_price);
    const unitPrice = basePrice + priceAdj + modAdj;
    const lineTotal = unitPrice;
    setCart(prev => [...prev, {
      product: variantProduct,
      quantity: 1,
      selectedVariants: variants.map(v => ({ id: v.id, name: v.name, price_adjustment: Number(v.price_adjustment ?? 0) })),
      selectedModifiers: modifiers,
      unitPrice,
      lineTotal,
    }]);
    closeVariantModal();
  }, [variantProduct, selectedVariants, closeVariantModal]);

  // ── Minimart adapters ─────────────────────────────────────────────────────
  const minimartAddToCart = useCallback((product: Product, qty?: number) => {
    if (qty !== undefined) {
      setCart(prev => {
        const existing = prev.find(i => i.product.id === product.id && i.selectedVariants.length === 0);
        if (existing) {
          const newQty = existing.quantity + qty;
          return prev.map(i => i === existing
            ? { ...i, quantity: newQty, lineTotal: i.unitPrice * newQty } : i);
        }
        return [...prev, {
          product, quantity: qty,
          selectedVariants: [], selectedModifiers: [],
          unitPrice: Number(product.base_price),
          lineTotal: Number(product.base_price) * qty,
        }];
      });
    } else {
      addToCart(product, {});
    }
  }, [addToCart]);

  const minimartUpdateQty = useCallback((productId: string, delta: number) => {
    setCart(prev =>
      prev
        .map(item => item.product.id === productId
          ? { ...item, quantity: item.quantity + delta, lineTotal: item.unitPrice * (item.quantity + delta) }
          : item)
        .filter(item => item.quantity > 0)
    );
  }, []);

  const minimartRemoveItem = useCallback((productId: string) => {
    setCart(prev => prev.filter(i => i.product.id !== productId));
  }, []);

  return {
    cart, setCart,
    addToCart, addFuelToCart, updateQty, removeItem,
    setItemCourse, toggleItemHold, clearCart,
    minimartAddToCart, minimartUpdateQty, minimartRemoveItem,
    variantProduct, selectedVariants,
    openVariantModal, closeVariantModal, toggleVariantOption, confirmVariants,
    fuelEntry, setFuelEntry, fuelEdited, setFuelEdited,
    fuelAmountStr, setFuelAmountStr, fuelLitresStr, setFuelLitresStr,
  };
}
