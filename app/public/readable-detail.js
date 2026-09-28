/** Presentation-only grouping for explicit lists in legacy prose.
 * The stored/model text is never rewritten. New drafts carry semantic
 * segments, while this remains a compatibility fallback for older cards.
 */
export function readableDetailBlocks(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const markers = [...text.matchAll(/(?:^|[：。；\n])\s*([1-9]\d?)[.、．]\s+/g)]
    .map((match) => ({ number: Number(match[1]), start: match.index + match[0].lastIndexOf(match[1]) }));
  const sequence = markers.length >= 2 && markers.every((marker, index) =>
    index === 0 || marker.number === markers[index - 1].number + 1);
  if (!sequence) {
    // A compact sequence of labelled clauses is also a list, not one long
    // sentence. Labels are read from the text; no topic or company is encoded.
    const clauses = text.split(/[；;]\s*/).map((part) => part.trim()).filter(Boolean);
    if (clauses.length >= 2) {
      const labelled = clauses.map((part) => part.match(/^([^：:；;。\n]{1,30})[：:]\s*(.+)$/s));
      if (labelled.every(Boolean)) {
        const items = labelled.map((match) => ({ label: match[1].trim(), text: match[2].trim() }));
        let trailing = '';
        const last = items.at(-1);
        const sentenceEnd = last.text.indexOf('。');
        if (sentenceEnd >= 0 && last.text.slice(sentenceEnd + 1).trim()) {
          trailing = last.text.slice(sentenceEnd + 1).trim();
          last.text = last.text.slice(0, sentenceEnd + 1).trim();
        }
        return [
          { kind: 'labeled_list', items },
          ...(trailing ? [{ kind: 'paragraph', text: trailing }] : [])
        ];
      }
    }
    return [{ kind: 'paragraph', text }];
  }

  const blocks = [];
  const introduction = text.slice(0, markers[0].start).trim();
  if (introduction) blocks.push({ kind: 'paragraph', text: introduction });
  const items = markers.map((marker, index) => text
    .slice(marker.start, markers[index + 1]?.start ?? text.length)
    .replace(/^\d+[.、．]\s+/, '')
    .trim());
  if (items.some((item) => !item)) return [{ kind: 'paragraph', text }];
  blocks.push({ kind: 'ordered_list', start: markers[0].number, items });
  return blocks;
}

/** New draft details carry semantic units; punctuation parsing above is only
 * for already-saved cards that do not have segments. */
export function detailBlocks(value, segments, kind = 'text') {
  if (!Array.isArray(segments) || !segments.length) return readableDetailBlocks(value);
  const items = segments.filter((item) => item && typeof item.text === 'string' && item.text.trim())
    .map((item) => ({ label: typeof item.label === 'string' ? item.label.trim() : '', text: item.text.trim() }));
  if (!items.length) return readableDetailBlocks(value);
  return [{ kind: kind === 'list' ? 'segment_list' : 'segment_paragraphs', items }];
}
