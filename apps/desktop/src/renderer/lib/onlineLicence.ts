/**
 * onlineLicence.ts — A460: does this client have the online licence (the web POS / web access)?
 *
 * Owner, 2026-10-13: product images, variants / modifiers / combos, offers setup and stock (counts, transfers, purchase
 * orders, wastage) "can be activated for desktop only if the client has paid for the online licence; if not they should
 * never be visible on the desktop app". The cloud says so with every catalogue pull (webPosEnabled → device_config
 * web_pos_enabled); not told yet counts as no.
 */
import { useEffect, useState } from 'react';
import { posApi } from './posApi';

export function useOnlineLicence(): boolean {
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => posApi.config.get().then((c) => { if (live) setOnline(c?.web_pos_enabled === true); }).catch(() => {});
    read();
    const off = posApi.pos.onCatalogueChanged(read);   // the licence can change with any pull
    return () => { live = false; off(); };
  }, []);
  return online;
}
