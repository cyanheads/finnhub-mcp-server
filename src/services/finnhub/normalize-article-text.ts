/**
 * @fileoverview Converts Finnhub headline and summary HTML fragments to text.
 */

import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html, parseFragment } from 'parse5';

const PARAGRAPH_TAGS = new Set([
  'address',
  'article',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);
const HIDDEN_TAGS = new Set(['script', 'style', 'template']);
const HTML_WHITESPACE = /[\t\n\f\r ]+/g;
const COMPACT_COMPARISON = /[A-Za-z0-9]<[A-Za-z]>[A-Za-z0-9]/;

/** Decode entities once and preserve paragraph and list-item boundaries from the parsed fragment. */
export function normalizeArticleText(value: string): string {
  if (!value.includes('<') && !value.includes('&')) return value.replace(/\r\n?/g, '\n');

  // An unmatched '<' can be an ordinary comparison, even following real markup.
  const tailStart = value.indexOf('<', value.lastIndexOf('>') + 1);
  const fragment =
    tailStart === -1
      ? value
      : value.slice(0, tailStart) + value.slice(tailStart).replaceAll('<', '&lt;');
  const { childNodes } = parseFragment(fragment, {
    sourceCodeLocationInfo: COMPACT_COMPARISON.test(fragment),
  });
  if (!childNodes.some(defaultTreeAdapter.isElementNode)) {
    return childNodes
      .filter(defaultTreeAdapter.isTextNode)
      .map((node) => node.value)
      .join('')
      .replace(/\r\n?/g, '\n');
  }

  const chunks: string[] = [];
  let pendingBreaks = 0;

  function appendText(value: string): void {
    const text = value.replace(HTML_WHITESPACE, ' ');
    if (text === ' ' && pendingBreaks) return;
    if (pendingBreaks && chunks.length) chunks.push('\n'.repeat(pendingBreaks));
    pendingBreaks = 0;
    chunks.push(text);
  }

  function visit(node: DefaultTreeAdapterTypes.ChildNode): void {
    if (defaultTreeAdapter.isTextNode(node)) {
      appendText(node.value);
      return;
    }
    if (!defaultTreeAdapter.isElementNode(node) || HIDDEN_TAGS.has(node.tagName)) return;
    if (node.tagName === 'br') {
      pendingBreaks += 1;
      return;
    }

    // HTML parsers read x<y>z as an opening tag. Preserve that exact operand
    // pattern when the tag has no HTML meaning and no matching end tag.
    const location = node.sourceCodeLocation;
    const startTag = location?.startTag;
    if (
      startTag &&
      !location.endTag &&
      html.getTagID(node.tagName) === html.TAG_ID.UNKNOWN &&
      COMPACT_COMPARISON.test(fragment.slice(startTag.startOffset - 1, startTag.endOffset + 1))
    ) {
      appendText(fragment.slice(startTag.startOffset, startTag.endOffset));
    }

    const breaks = PARAGRAPH_TAGS.has(node.tagName) ? 2 : node.tagName === 'li' ? 1 : 0;
    pendingBreaks = Math.max(pendingBreaks, breaks);
    for (const child of node.childNodes) visit(child);
    pendingBreaks = Math.max(pendingBreaks, breaks);
  }

  for (const node of childNodes) visit(node);
  return chunks
    .join('')
    .replace(/ {2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^ +| +$/g, '');
}
