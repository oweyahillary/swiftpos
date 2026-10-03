/**
 * helpTopics.ts — 0.6.35 (A384): "What to do when" — the owner-approved help text (2026-10-03, "approved").
 *
 * The same words on the till's Help screen (offline, from the PIN pad, the POS and the manager screens), the printable
 * A4 card and the web's Help page. The last topic ("Who to call") is filled with the shop's own tech or SwiftPOS support
 * (shared/support.ts).
 *
 * ONE file: shared/helpTopics.ts, copied to the till's renderer and the web (scripts/check-shared-sync.mjs).
 */

export interface HelpTopic {
  id: string;
  title: string;
  /** What to do, in order. */
  steps: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'internet',
    title: 'The internet is down',
    steps: [
      'Keep selling. Cash and card sales are saved on the till and go to the cloud by themselves when the internet returns.',
      'M-Pesa prompts need internet. Without it, take the M-Pesa payment on the shop\'s phone, then record the sale as M-Pesa with the code.',
      'Do not switch the till off until the screen shows it has synced.',
    ],
  },
  {
    id: 'mpesa',
    title: 'M-Pesa payment is not confirming',
    steps: [
      'Wait 1 minute. Ask the customer to show the M-Pesa message.',
      'If they have it, record the payment manually with the code.',
      'If they do not, press Retry once.',
      'Never release goods without a code or a confirmation on the screen.',
      'If it keeps happening, call support (we are usually already alerted).',
    ],
  },
  {
    id: 'printer',
    title: 'The printer will not print',
    steps: [
      'Check: paper in, lid shut, light green, cable or Wi-Fi connected.',
      'Switch the printer off and on, then reprint from History. The sale is already saved; a failed print never loses it.',
      'A kitchen ticket that failed shows a warning on the till. Reprint it from the order.',
    ],
  },
  {
    id: 'day',
    title: '"Day not closed" or "No shift open"',
    steps: [
      'The manager counts the cash and closes the old day (Manager → Close Day), then opens today.',
      'A cashier cannot skip this.',
      'The business day ends at the owner\'s set time (for example 04:00), so selling after midnight is fine until then.',
    ],
  },
  {
    id: 'reverse',
    title: 'A sale is wrong (void or refund)',
    steps: [
      'Within the void window (30 minutes unless the owner changed it), a manager voids it with their PIN.',
      'After that, refund it. Cash refunds work offline; other methods need internet unless the owner allowed them.',
      'Every void or refund needs a reason and the manager\'s PIN.',
    ],
  },
  {
    id: 'pin',
    title: 'Forgot the PIN or locked out',
    steps: [
      'A manager resets the staff member\'s PIN from the Staff page.',
      'Without internet, staff can sign in with their PIN for up to 14 days on a till that works alone (no limit when there is a branch server). After that the till needs internet once.',
    ],
  },
  {
    id: 'power',
    title: 'Power cut',
    steps: [
      'Every completed sale is saved the moment it is paid.',
      'When power returns, start the till and sign in. Open orders and held bills are still there.',
      'A UPS (backup battery) for the till and the router is strongly advised.',
    ],
  },
  {
    id: 'cash',
    title: 'Cash is short or over',
    steps: [
      'Count again with a second person.',
      'Check History for refunds, expenses and rider pay-outs taken from the drawer.',
      'Enter the real count. Never "adjust" it to match: the difference and your reason go on the report for the owner.',
    ],
  },
  {
    id: 'update',
    title: 'The till will not open or asks for an update',
    steps: [
      'Restart the computer.',
      'If it says an update is needed, connect to the internet and let it finish. Do not switch off during the update.',
      'If it still will not open, call support. Your sales are safe on the till.',
    ],
  },
];

/** The last topic, filled with who to call (shared/support.ts supportContact → name + display numbers). */
export function whoToCallSteps(name: string, phones: string[]): string[] {
  return [
    `${name}: ${phones.join(' or ')} (call or WhatsApp).`,
    'Have ready: the shop name, the till name and version (shown on this Help page) and a photo of the error.',
  ];
}

export const WHO_TO_CALL_TITLE = 'Who to call';
