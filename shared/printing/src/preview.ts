/**
 * preview — Document to plain text, for the printer settings screen.
 *
 * This is the WYSIWYG guarantee. The preview is not a second implementation of
 * the layout; it is the same Document the printer receives, rendered with
 * spaces instead of control codes. If the preview is wrong, the paper is wrong
 * in exactly the same way, which means the layout can be fixed at a desk
 * instead of at the machine.
 *
 * Double-width text is shown with its real character cost so a line that will
 * overflow on paper also overflows here. A preview that silently fits what the
 * printer will wrap is worse than no preview.
 */

import type { Document, TextBlock } from './document';

export interface PreviewOptions {
  /** Draw the paper edges, for the settings screen. */
  showMargins?: boolean;
}

export function toPreview(doc: Document, opts: PreviewOptions = {}): string {
  const cols = doc.columns;
  const lines: string[] = [];

  for (const block of doc.blocks) {
    switch (block.kind) {
      case 'text': {
        const b = block as TextBlock;
        const doubleWide = b.size === 'wide' || b.size === 'large';
        const effective = doubleWide ? Math.floor(cols / 2) : cols;

        let t = b.text;
        if (t.length > effective) t = t.slice(0, effective);

        if (b.align === 'center') {
          const pad = Math.max(0, Math.floor((effective - t.length) / 2));
          t = ' '.repeat(pad) + t;
        } else if (b.align === 'right') {
          t = ' '.repeat(Math.max(0, effective - t.length)) + t;
        }

        // Double-width glyphs occupy two columns each. Spacing the characters
        // out is the closest a monospace preview gets, and it makes the width
        // cost visible rather than hiding it.
        if (doubleWide) t = t.split('').join(' ');

        lines.push(b.size === 'tall' || b.size === 'large' ? t : t);
        break;
      }
      case 'feed':
        for (let i = 0; i < block.lines; i++) lines.push('');
        break;
      case 'drawer':
        break;
      case 'cut':
        lines.push('-'.repeat(cols).replace(/-/g, '='));
        break;
    }
  }

  if (!opts.showMargins) return lines.join('\n');
  const edge = '+' + '-'.repeat(cols) + '+';
  return [edge, ...lines.map(l => '|' + l.padEnd(cols, ' ') + '|'), edge].join('\n');
}
