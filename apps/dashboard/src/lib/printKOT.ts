/**
 * printKOT — now a types-only module.
 *
 * The KOT fan-out (printKOTs) and its ESC/POS/HTML builders were superseded by
 * printRouted.ts (A252/A253): a single routed fan-out that uses the shared engine
 * and fires kitchen/dispatch at Send-to-Kitchen. Only the shared config types
 * remain here, where several modules already import them from.
 */

export interface BranchPrinter {
  id: string;
  name: string;
  printer_name: string | null;
  type: 'receipt' | 'kitchen' | 'bar' | 'expeditor' | 'kot';
  paper_width: 58 | 80;
  category_ids: string[];      // empty = all items
  is_default_receipt: boolean;
  connection_type: 'qz' | 'browser';
  enabled: boolean;
}

export interface KOTContext {
  orderNumber: string;
  tableNumber?: string;
  orderType:   string;
  staffName?:  string;
  branchName?: string;
  notes?:      string;
}
