/**
 * menus.ts — A537: a business's menus (Food, Soft drinks, Alcohol, Tea …), one menu per category (migration 155).
 *
 * Owner, 2026-10-20: "some restaurants have different menus — food menu, non-alcoholic drinks menu, alcoholic drinks
 * menu, tea menu etc, can we include such?" — plain menus (no hours or days for now), one menu per category.
 *
 * The checks the menu routes and a category's save share: a clean name and colour, and that a menu a category is put
 * under is this business's own (another business's menu id is refused as not found — nothing says it exists).
 */
import { supabase } from './supabase';
import { checkAvailability, readAvailability, type MenuAvailability } from '@zaptill/core/menuHours';   // A578

export const MENU_NAME_MAX = 60;
const HEX = /^#[0-9a-fA-F]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ok, or the words of the refusal (one shape — the server builds without strictNullChecks, so no union to narrow). */
export interface Clean<T> { ok: boolean; value: T; error: string }
const yes = <T>(value: T): Clean<T> => ({ ok: true, value, error: '' });
const no = <T>(error: string): Clean<T> => ({ ok: false, value: null as unknown as T, error });

export function cleanMenuName(v: unknown): Clean<string> {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) return no('A menu needs a name');
  if (s.length > MENU_NAME_MAX) return no(`A menu name is at most ${MENU_NAME_MAX} characters`);
  return yes(s);
}
export function cleanMenuColor(v: unknown): Clean<string | null> {
  if (v === null || v === undefined || v === '') return yes<string | null>(null);
  return typeof v === 'string' && HEX.test(v) ? yes<string | null>(v) : no('colour must be a hex colour e.g. #f97316');
}
export function cleanMenuIcon(v: unknown): Clean<string | null> {
  if (v === null || v === undefined || v === '') return yes<string | null>(null);
  return typeof v === 'string' && v.trim().length <= 8 ? yes<string | null>(v.trim()) : no('icon must be a short emoji');
}

/** A Postgres unique violation (the menu name index): answered as a 409 with words. */
export function isDuplicateName(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === '23505' || /duplicate key|menus_business_name/i.test(String(e.message ?? '')));
}
/** The table is not there yet (migration 155 not run). */
export function menusMissing(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (['42P01', '42703', 'PGRST204', 'PGRST205'].includes(String(e.code ?? '')) || /does not exist|could not find the/i.test(String(e.message ?? '')));
}

/**
 * The menu a category may be put under: null clears it; otherwise a menu of THIS business, not deleted. Another
 * business's menu (or none such) is "Menu not found".
 */
export async function menuIdForCategory(businessId: string, v: unknown): Promise<Clean<string | null>> {
  if (v === null || v === '') return yes<string | null>(null);
  if (typeof v !== 'string' || !UUID.test(v)) return no('menu_id must be a menu id or null');
  const { data, error } = await supabase.from('menus').select('id').eq('id', v).eq('business_id', businessId).is('deleted_at', null).maybeSingle();
  if (error || !data) return no('Menu not found');
  return yes<string | null>(v);
}

/**
 * The business's menus for a POS: on and not deleted, in the owner's order. Before migration 155: none.
 * A578: each with its hours (availability — null = always). Before migration 165 the column is not there: the menus
 * still go, without hours (a POS reads a missing availability as always).
 */
export async function menusForPos(businessId: string): Promise<Array<Record<string, unknown>>> {
  const read = (cols: string) => supabase.from('menus').select(cols)
    .eq('business_id', businessId).eq('active', true).is('deleted_at', null).order('sort_order', { ascending: true });
  let { data, error } = await read('id, name, sort_order, active, color, icon, availability');
  if (error && menusMissing(error)) ({ data, error } = await read('id, name, sort_order, active, color, icon'));
  if (error) return [];
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((m) => ({ ...m, availability: readAvailability(m.availability) }));
}

/**
 * A578: the hours an owner sends for a menu → what to store (null = always), or the words of why not
 * (shared/menuHours.ts — the POS reads the same shape).
 */
export function cleanMenuAvailability(v: unknown): Clean<MenuAvailability | null> {
  const r = checkAvailability(v);
  return r.ok ? yes<MenuAvailability | null>(r.value) : no(r.error);
}
