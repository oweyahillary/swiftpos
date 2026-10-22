/**
 * ZapTill's ready-made staff roles, in owner language. Taken from BUILT_IN_ROLES in apps/server/src/lib/permissions.ts
 * (twelve for every business, plus Fuel attendant for petrol stations). Keep the two in step.
 */
export const ROLES: { name: string; does: string; petrol?: boolean }[] = [
  { name: 'General Manager', does: 'Runs the whole business day to day, with every permission except being the owner.' },
  { name: 'Operations Manager', does: 'Menu and prices, offers, stock, the kitchen, shifts, the day and branch close, and staff.' },
  { name: 'Finance Manager', does: 'Every report, plus paying suppliers, recording expenses, customer credit and checking drawers.' },
  { name: 'Auditor', does: 'Sees every report and figure a non-owner can see, and changes nothing.' },
  { name: 'Kitchen Manager', does: 'The menu, recipes and costs; receiving, counting and writing off stock.' },
  { name: 'Manager', does: 'Runs a branch.' },
  { name: 'Supervisor', does: 'Sells, and approves voids, refunds, sales on account and drawers with their PIN.' },
  { name: 'Cashier', does: 'Sells at the till.' },
  { name: 'Waiter', does: 'Takes orders, sends them to the kitchen and takes payment.' },
  { name: 'Kitchen', does: 'Reads the menu; the kitchen display has its own sign-in.' },
  { name: 'Storekeeper', does: 'Receives deliveries, moves stock between branches, counts it and writes it off.' },
  { name: 'Accountant', does: 'Reads the books: every report, the orders and the expenses, and changes nothing.' },
  { name: 'Fuel attendant', does: 'Sells fuel at the pumps (petrol stations only).', petrol: true },
];
