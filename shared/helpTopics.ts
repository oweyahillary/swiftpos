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
  /**
   * A422 part 2: a picture of the real screen beside a step — a file name in each app's public/help-img/ (shipped with
   * the till, so Help works offline), null where the step needs none. Same order as `steps`. The printed card has none.
   */
  images?: Array<string | null>;
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

/**
 * A575: the topics a business of this kind reads. The printer topic's kitchen-ticket step is a restaurant's or café's
 * only — a shop, a petrol station or a car park sends nothing to a kitchen. `foodService` is businessTerms.ts
 * isFoodService(type) (a type not known yet: true, every step, as before).
 */
export function helpTopicsFor(foodService: boolean): HelpTopic[] {
  if (foodService) return HELP_TOPICS;
  return HELP_TOPICS.map((t) => {
    const k = t.steps.findIndex((x) => /kitchen ticket/i.test(x));
    if (k < 0) return t;
    return { ...t, steps: t.steps.filter((_, i) => i !== k), ...(t.images ? { images: t.images.filter((_, i) => i !== k) } : {}) };
  });
}

/** The last topic, filled with who to call (shared/support.ts supportContact → name + display numbers). */
export function whoToCallSteps(name: string, phones: string[]): string[] {
  return [
    `${name}: ${phones.join(' or ')} (call or WhatsApp).`,
    'Have ready: the shop name, the till name and version (shown on this Help page) and a photo of the error.',
  ];
}

export const WHO_TO_CALL_TITLE = 'Who to call';

/**
 * A422 (owner, 2026-10-09: "Build a detailed help … especially for simple tasks like opening, closing day, manager
 * confirming shift and closing day etc, well detailed"). Step by step, in the words on the screens (read from the code,
 * 2026-10-10). DRAFT for the owner's review — the approved "What to do when" list above is unchanged. Screenshots come
 * next (A422 part 2): they need the real screens.
 */
export const HOW_TO: HelpTopic[] = [
  {
    id: 'howto-open-shift',
    title: 'Open your shift (start of the day)',
    steps: [
      'On the PIN screen, type your PIN and press Enter.',
      'The "Open your drawer" box opens with your name. Count the cash in the drawer and type it in "Opening float" (0 if it is empty).',
      'Press "Start selling". The top bar now shows a green "Shift open".',
      'If the box shows someone else\'s name, press "Not you? Sign out" — never open a shift under another person\'s name.',
    ],
    images: ['open-1.jpg', 'open-2.jpg', 'open-3.jpg', null],
  },
  {
    id: 'howto-close-shift',
    title: 'Close your shift (end of your work)',
    steps: [
      'Finish or hold every open order first.',
      'Tap "Shift open" in the top bar. The shift panel opens; "Close shift" is at the bottom of the Shift tab.',
      'Count the cash in the drawer — include the opening float — and type it in "Counted cash in drawer".',
      'Type the total for each other payment method listed (M-Pesa from the statement, card from the card machine). Type 0 if none.',
      'Press "Close shift" (on some tills "Close shift & print Z-report"). If your report shows, press "Done — sign out". The PIN screen says "Shift closed." and is ready for the next person.',
      'Leave the counted cash in the drawer (or as the manager tells you). A manager checks your count.',
    ],
    images: [null, 'close-2.jpg', 'close-3.jpg', null, 'close-5.jpg', 'close-6.jpg'],
  },
  {
    id: 'howto-confirm-shift',
    title: 'Manager: confirm a closed shift',
    steps: [
      'Sign in with your manager PIN and open Manager.',
      'Find the shift: Overview › "Shift report — today" (any till), or Sales › Shift report, or Close › Close Day (this till). It says "Awaiting manager".',
      'Press "Confirm". Count every payment method yourself — the drawer, the M-Pesa statement, the card machine\'s total.',
      'Type what YOU counted. Where the business shows the cashier\'s figure, give a reason for any difference.',
      'Press "Confirm shift". The shift shows "Confirmed" by your name. A shift on another till is confirmed there too within a minute.',
    ],
    images: ['confirm-1.jpg', 'confirm-2.jpg', null, 'confirm-4.jpg', 'confirm-5.jpg'],
  },
  {
    id: 'howto-close-day',
    title: 'Manager: close the day',
    steps: [
      'Every shift on this till must be closed and confirmed first (see the two guides above).',
      'Open Manager › Close › Close Day.',
      'Count the cash and type it in "Cash you counted". Add a note if anything is unusual.',
      'Press "Count verified — close the day". The screen shows "Day closed".',
      'Do this on every till. On the branch server, Close › Close Branch shows every till\'s day and drawer, and can close them together.',
      'If a shift opens later the same day, the day reopens; the next close counts only the cash since.',
    ],
    images: [null, 'day-2.jpg', 'day-3.jpg', 'day-4.jpg', null, null],
  },
  {
    id: 'howto-void-refund',
    title: 'Manager: void or refund a sale',
    steps: [
      'Tap "History" in the top bar of the selling screen.',
      'Find the sale. Within the void window it shows "Void / Refund"; after it, "Refund".',
      'Press it, choose why, and confirm. Once money has changed hands a manager\'s PIN is needed.',
      'Give the money back in the same way it was paid (cash for cash, M-Pesa for M-Pesa).',
      'Cashiers do not see these buttons — call a manager.',
    ],
    images: ['void-1.jpg', 'void-2.jpg', 'void-3.jpg', null, null],
  },
];
