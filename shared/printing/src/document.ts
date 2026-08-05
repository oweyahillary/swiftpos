/**
 * document — the intermediate form every ticket passes through.
 *
 * The renderer produces a Document. Two serialisers consume it: one emits
 * ESC/POS bytes for the printer, one emits plain text for the settings-screen
 * preview. They are the ONLY two consumers, and neither knows anything about
 * orders or menus.
 *
 * This indirection exists for one reason: yesterday's setup screen previewed
 * something other than what came out of the printer, so tuning the layout meant
 * printing a test, walking to the machine, reading it, and going back. With a
 * single Document behind both, a preview that looks right IS right — there is
 * no second layout engine to disagree with the first.
 */

export type Align = 'left' | 'center' | 'right';

/** Maps to the printer's character-size register. 'large' is double both ways. */
export type Size = 'normal' | 'tall' | 'wide' | 'large';

export interface TextBlock {
  kind: 'text';
  text: string;
  align: Align;
  size: Size;
  bold: boolean;
}

export interface FeedBlock { kind: 'feed'; lines: number }
export interface CutBlock { kind: 'cut' }
export interface DrawerBlock { kind: 'drawer' }

export type Block = TextBlock | FeedBlock | CutBlock | DrawerBlock;

export interface Document {
  /** Character columns this document was laid out for. A serialiser must not
   *  re-flow it; if the width is wrong the fix is to render again. */
  columns: number;
  blocks: Block[];
}

export class DocBuilder {
  private blocks: Block[] = [];

  constructor(readonly columns: number) {}

  /** Pre-formatted lines from layout.ts go through here unchanged. */
  line(text: string, opts: Partial<Omit<TextBlock, 'kind' | 'text'>> = {}): this {
    this.blocks.push({
      kind: 'text',
      text,
      align: opts.align ?? 'left',
      size: opts.size ?? 'normal',
      bold: opts.bold ?? false,
    });
    return this;
  }

  lines(texts: string[], opts: Partial<Omit<TextBlock, 'kind' | 'text'>> = {}): this {
    for (const t of texts) this.line(t, opts);
    return this;
  }

  blank(n = 1): this {
    for (let i = 0; i < n; i++) this.line('');
    return this;
  }

  feed(lines: number): this {
    this.blocks.push({ kind: 'feed', lines });
    return this;
  }

  cut(): this {
    this.blocks.push({ kind: 'cut' });
    return this;
  }

  drawer(): this {
    this.blocks.push({ kind: 'drawer' });
    return this;
  }

  /** Blocks emitted so far. Lets a caller tell whether a section printed
   *  anything without inspecting the blocks themselves. */
  get length(): number {
    return this.blocks.length;
  }

  build(): Document {
    return { columns: this.columns, blocks: this.blocks };
  }
}
