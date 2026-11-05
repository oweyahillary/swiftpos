/**
 * CategoryPanel — A537: the web POS's categories in a collapsible left panel, with the business's menus as tabs on top;
 * the ☰ toggle, the "Burgers ✕" chip, A566's menu bar and A580's Later button.
 *
 * The panel and its pieces (what they draw, what they do, the remembered menu) are @zaptill/ui/CategoryPanel — shared
 * with the desktop POS (docs/SHARED-COMPONENTS-PLAN.md section 8g). This file is the web's look: every element's inline
 * style, on the theme (--act-strong) and the POS's light / dark tokens (--pos-*). On a narrow screen the panel lies over
 * the grid (CashierScreen / MinimartPOS pass `overlay`). 8n: CategoryBar — the categories across the top (the branch's
 * 'top' layout), 48 px pills in the category's colour when chosen.
 */
import SharedCategoryPanel, {
  CategoryBar as SharedCategoryBar, CategoryChip as SharedCategoryChip, LaterButton as SharedLaterButton, MenuBar as SharedMenuBar, PanelToggle as SharedPanelToggle, withLook,
  type CategoryBarProps, type CategoryChipProps, type CategoryPanelLook, type CategoryPanelProps, type LaterButtonProps, type MenuBarProps, type PanelToggleProps,
} from '@zaptill/ui/CategoryPanel';

export { useCategoryPanel, type CategoryPanelState } from '@zaptill/ui/CategoryPanel';

const ACT = 'rgb(var(--act-strong, 15 118 110))';

/** A menu tab across the top: big (46 px), as the categories were before A537. */
const BAR_TAB = { flexShrink: 0, minHeight: 46, minWidth: 84, padding: '0 18px', borderRadius: 10, cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700 } as const;

const LOOK: CategoryPanelLook = {
  toggle: (open) => ({
    style: { flexShrink: 0, minWidth: 44, minHeight: 38, borderRadius: 8, border: '1px solid var(--pos-input-border, #334155)',
             background: open ? 'var(--pos-surface, #1e293b)' : 'var(--pos-input, #0f172a)', color: 'var(--pos-text, #f1f5f9)',
             fontSize: 18, cursor: 'pointer' },
  }),
  chip: {
    style: { flexShrink: 0, maxWidth: 200, minHeight: 38, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px',
             borderRadius: 999, border: '1px solid var(--pos-border, #334155)', background: 'var(--pos-surface, #1e293b)',
             color: 'var(--pos-text, #f1f5f9)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  },
  chipText: { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
  chipClear: { style: { color: 'var(--pos-text3, #94a3b8)' } },

  bar: { style: { position: 'relative', flexShrink: 0, borderBottom: '1px solid var(--pos-border-l, #1e293b)', display: 'flex', alignItems: 'center' } },
  barScroller: { style: { position: 'relative', flex: 1, minWidth: 0 } },
  barRow: { style: { display: 'flex', gap: 8, padding: '8px 12px', overflowX: 'auto', scrollbarWidth: 'none' } },
  // A580: a closed menu shown by "Later" — greyed, dashed.
  barTab: (on, later) => ({
    style: later
      ? { ...BAR_TAB, opacity: 0.55, filter: 'grayscale(1)',
          border: `1px dashed ${on ? 'var(--pos-text, #f1f5f9)' : 'var(--pos-border, #334155)'}`,
          background: on ? 'var(--pos-border, #334155)' : 'transparent', color: 'var(--pos-text, #f1f5f9)' }
      : { ...BAR_TAB, border: `1px solid ${on ? ACT : 'var(--pos-border, #334155)'}`,
          background: on ? ACT : 'var(--pos-surface, #1e293b)', color: on ? '#fff' : 'var(--pos-text, #f1f5f9)' },
  }),
  barTabIcon: { style: { marginRight: 6 } },
  barHint: () => ({ style: { marginLeft: 8, fontSize: 12, fontWeight: 500, opacity: 0.8 } }),
  // The ‹ › arrows: over the row's end, fading into the background.
  barArrow: (side) => ({
    style: {
      position: 'absolute', top: 0, bottom: 0, [side]: 0, zIndex: 2, width: 52, display: 'flex', alignItems: 'center',
      justifyContent: side === 'left' ? 'flex-start' : 'flex-end', padding: side === 'left' ? '0 0 0 8px' : '0 8px 0 0',
      border: 'none', cursor: 'pointer', fontSize: 24, fontWeight: 700, color: 'var(--pos-text, #f1f5f9)',
      background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, var(--pos-bg, #0f172a) 45%, transparent)`,
    },
  }),
  barTrailing: { style: { flexShrink: 0, paddingRight: 12, display: 'flex', alignItems: 'center', gap: 8 } },

  later: (on) => ({
    style: { minHeight: 40, padding: '0 12px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600,
             border: '1px dashed var(--pos-border, #475569)', background: on ? 'var(--pos-border, #334155)' : 'transparent',
             color: 'var(--pos-text, #f1f5f9)', opacity: on ? 1 : 0.8 },
  }),
  laterIcon: { style: { marginRight: 4 } },

  panel: (overlay) => ({
    style: { width: 248, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--pos-panel, #0f172a)',
             borderRight: '1px solid var(--pos-border-l, #1e293b)',
             ...(overlay ? { position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 31, boxShadow: '8px 0 24px rgba(0,0,0,0.35)' } : {}) },
  }),
  header: { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 6px' } },
  title: { style: { flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--pos-text3, #94a3b8)' } },
  pin: (pinned) => ({
    style: { minWidth: 40, minHeight: 36, borderRadius: 8, cursor: 'pointer', fontSize: 15,
             border: `1px solid ${pinned ? ACT : 'var(--pos-border, #334155)'}`,
             background: pinned ? ACT : 'transparent', color: pinned ? '#fff' : 'var(--pos-text3, #94a3b8)' },
  }),
  close: {
    style: { minWidth: 40, minHeight: 36, borderRadius: 8, cursor: 'pointer', fontSize: 15, border: '1px solid var(--pos-border, #334155)',
             background: 'transparent', color: 'var(--pos-text3, #94a3b8)' },
  },
  tabs: { style: { display: 'flex', gap: 6, padding: '4px 10px 8px', overflowX: 'auto', flexShrink: 0 } },
  tab: (on) => ({
    style: { flexShrink: 0, minHeight: 36, padding: '0 12px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
             fontSize: 12, fontWeight: 600, border: `1px solid ${on ? 'transparent' : 'var(--pos-border, #334155)'}`,
             background: on ? ACT : 'var(--pos-surface, #1e293b)', color: on ? '#fff' : 'var(--pos-text3, #94a3b8)' },
  }),
  tabIcon: { style: { marginRight: 4 } },
  list: { style: { flex: 1, overflowY: 'auto', padding: '2px 8px 12px' } },
  // Touch-sized rows (44 px); the chosen one in the theme.
  row: (on) => ({
    style: { width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 10,
             border: '1px solid transparent', textAlign: 'left', cursor: 'pointer', fontSize: 14, fontWeight: on ? 700 : 500,
             background: on ? ACT : 'transparent', color: on ? '#fff' : 'var(--pos-text, #f1f5f9)' },
  }),
  rowLabel: { style: { flex: 1 } },
  heading: {
    style: { padding: '12px 12px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
             color: 'var(--pos-text3, #94a3b8)' },
  },
  dot: (colour) => ({ style: { width: 10, height: 10, borderRadius: 999, flexShrink: 0, background: colour ?? 'var(--pos-border, #334155)' } }),
  name: { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
  count: (on) => ({ style: { fontSize: 11, color: on ? '#fff' : 'var(--pos-text3, #94a3b8)' } }),
  backdrop: { style: { position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.35)' } },

  // 8n: the top bar — a slimmer row than the menu tabs above it, so the two read as menu, then category.
  catBar: { style: { position: 'relative', flexShrink: 0, borderBottom: '1px solid var(--pos-border-l, #1e293b)' } },
  catRow: { style: { display: 'flex', gap: 8, padding: '6px 12px', overflowX: 'auto', scrollbarWidth: 'none' } },
  // Chosen: the category's own colour, else the theme (All, a category with none).
  catPill: (on, colour) => ({
    style: { flexShrink: 0, minHeight: 48, padding: '0 16px', borderRadius: 10, cursor: 'pointer', whiteSpace: 'nowrap',
             fontSize: 14, fontWeight: on ? 700 : 500, border: `1px solid ${on ? 'transparent' : 'var(--pos-border, #334155)'}`,
             background: on ? (colour ?? ACT) : 'var(--pos-surface, #1e293b)', color: on ? (colour ? '#0f172a' : '#fff') : 'var(--pos-text, #f1f5f9)' },
  }),
  catPillIcon: { style: { marginRight: 4 } },
};

/** The ☰ button at the left of the search. */
export const PanelToggle = withLook<PanelToggleProps>(SharedPanelToggle, LOOK);

/** "Burgers ✕" by the search — the chosen category (and menu), one tap back to everything. */
export const CategoryChip = withLook<CategoryChipProps>(SharedCategoryChip, LOOK);

/** A566: the menus across the top of the grid. A573: `label` is the business's word for them (@zaptill/core/businessTerms). */
export const MenuBar = withLook<MenuBarProps>(SharedMenuBar, LOOK);

/** 8n: the categories across the top of the grid — only with the branch's 'top' layout (useCategoryPanel(layout)). */
export const CategoryBar = withLook<CategoryBarProps>(SharedCategoryBar, LOOK);

/** A580: "Later" at the end of the menu bar — the closed menus, greyed, view only. */
export const LaterButton = withLook<LaterButtonProps>(SharedLaterButton, LOOK);

export default withLook<CategoryPanelProps>(SharedCategoryPanel, LOOK);
