import type { Order, BusinessConfig } from '../src/index';

export const KITCHEN = 'st-kitchen';
export const DISPATCH = 'st-dispatch';
const BOTH = [KITCHEN, DISPATCH];
const PACK = [DISPATCH];

export const business: BusinessConfig = {
  name: 'KUDO KUDO',
  branchName: 'Kilimani Branch',
  kraPin: 'P051234567X',
  telephone: '0700 000 033',
  tillLabel: 'Buy Goods',
  tillNumber: '3423273',
  thankYouMessage: 'Thank you for your business!',
  deliveryMessage: 'For Delivery call 0117 000 033',
  footerCredit: 'Powered by SwiftPOS',
  currencyCode: 'KES',
  vatRate: 16,
  ctlRate: 2,
};

export const order: Order = {
  billNumber: 'T1--5718',
  orderType: 'takeaway',
  cashierName: 'grace wanjiku',
  soldAt: new Date(2026, 7, 5, 19, 42, 11),
  kotCount: 2,
  changeGiven: 20000,
  total: 330000,
  payments: [{ label: 'Cash', amount: 350000 }],
  lines: [
    {
      name: '3PC Chicken Combo',
      quantity: 1,
      unitPrice: 89000,
      lineTotal: 100000,
      stationIds: [],
      units: [
        { productId: 'p-chick3', name: '3PC Chicken', quantity: 1, portions: 3,
          priceDelta: 0, chosen: false, stationIds: BOTH,
          // Kudo Kudo sells spice as all-or-nothing per item, so one option
          // covers every portion and the ticket reads "all spicy". The split
          // form (1 spicy, 2 normal) still renders correctly if a client ever
          // needs it — it is two entries instead of one, no schema change.
          attributes: [
            { group: 'Spice', option: 'spicy', count: 3, priceDelta: 0 },
          ] },
        { productId: 'p-frieslg', name: 'Fries large', quantity: 1, portions: 1,
          priceDelta: 6000, chosen: true, stationIds: BOTH, attributes: [] },
        { productId: 'p-popcorn', name: 'Popcorn chicken', quantity: 1, portions: 1,
          priceDelta: 0, chosen: false, stationIds: BOTH, attributes: [] },
        { productId: 'p-slaw', name: 'Cole slaw', quantity: 1, portions: 1,
          priceDelta: 0, chosen: false, stationIds: PACK, attributes: [] },
        { productId: 'p-soda125', name: 'Soda 1.25L', quantity: 1, portions: 1,
          priceDelta: 5000, chosen: true, stationIds: PACK, attributes: [] },
      ],
    },
    {
      name: 'Wings Combo 8PC',
      quantity: 2,
      unitPrice: 109000,
      lineTotal: 218000,
      stationIds: [],
      units: [
        { productId: 'p-wings8', name: '8PC Hot Wings', quantity: 1, portions: 8,
          priceDelta: 0, chosen: false, stationIds: BOTH,
          attributes: [{ group: 'Spice', option: 'spicy', count: 8, priceDelta: 0 }] },
        { productId: 'p-friesmd', name: 'Fries medium', quantity: 1, portions: 1,
          priceDelta: 0, chosen: false, stationIds: BOTH, attributes: [] },
        { productId: 'p-bbq', name: 'BBQ Sauce', quantity: 1, portions: 1,
          priceDelta: 0, chosen: true, stationIds: PACK, attributes: [] },
        { productId: 'p-garlic', name: 'Garlic Sauce', quantity: 1, portions: 1,
          priceDelta: 0, chosen: true, stationIds: PACK, attributes: [] },
      ],
    },
    {
      name: 'Soda 500ml',
      quantity: 1,
      unitPrice: 12000,
      lineTotal: 12000,
      stationIds: ['st-dispatch'],
      units: [],
    },
  ],
};

