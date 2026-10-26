import type { Note } from './model.ts';
import { formulaFor, editableBlockText } from './draft-content.ts';
import { ensurePageModel, updateBlock, updateFormulaLatex, createParagraphBlock, moveBlock, removeBlock, type InlineRun } from './page-model.ts';

function mathTokens(text: string): { start: number; end: number; latex: string }[] { const escaped = (i: number) => { let count = 0; for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) count++; return count % 2 === 1; }; const matches: { start: number; end: number; latex: string }[] = []; for (let start = 0; start < text.length; start++) { if (text[start] !== '$' || escaped(start)) continue; let end = start + 1; while (end < text.length && text[end] !== '\n' && (text[end] !== '$' || escaped(end))) end++; if (end < text.length && text[end] === '$' && end > start + 1) { matches.push({ start, end: end + 1, latex: text.slice(start + 1, end) }); start = end; } } return matches; }
/** Explicit edits retain canonical identities and source refs; preview never calls this. */
export function editDraftBlockText(document: Note, blockId: string, text: string): boolean {
  const n = ensurePageModel(document), block = n.blocks.find(b => b.id === blockId);
  if (!block || editableBlockText(n, block) === text) return false;
  if (block.type === 'formula' || block.type === 'derivation') return updateFormulaLatex(n, block.content.formulaId!, text);
  if (block.type === 'legacy-markdown') return updateBlock(n, block.id, { content: { markdown: text } });
  if (block.type === 'image') return updateBlock(n, block.id, { content: { ...block.content, caption: text } });
  const tokens = mathTokens(text), available = (block.content.runs || []).filter((r): r is Extract<InlineRun, { type: 'formula' }> => r.type === 'formula'), resolved = new Map<number, string>();
  for (const run of available) { const formula = n.formulas.find(f => f.id === run.formulaId); if (formula) formula.inline = true; }
  tokens.forEach((token, index) => { const position = available.findIndex(r => n.formulas.find(f => f.id === r.formulaId)?.latex === token.latex); if (position >= 0) resolved.set(index, available.splice(position, 1)[0].formulaId); });
  const source = n.sources.find(s => block.sourceRefIds.includes(s.id)), reserved = new Set(resolved.values()), unused = [...new Set(available.map(r => r.formulaId))].filter(id => !reserved.has(id));
  let formulaChanged = false;
  tokens.forEach((token, index) => { if (resolved.has(index)) return; const previous = unused.shift(); if (previous) { formulaChanged = updateFormulaLatex(n, previous, token.latex) || formulaChanged; resolved.set(index, previous); } else { const f = formulaFor(n, token.latex, source, true); if (!source) f.provider = 'manual'; resolved.set(index, f.id); } });
  const runs: InlineRun[] = []; let cursor = 0;
  tokens.forEach((token, index) => { if (token.start > cursor) runs.push({ type: 'text', text: text.slice(cursor, token.start) }); runs.push({ type: 'formula', formulaId: resolved.get(index)! }); cursor = token.end; });
  if (cursor < text.length || !runs.length) runs.push({ type: 'text', text: text.slice(cursor) });
  return updateBlock(n, block.id, { content: { ...block.content, runs } }) || formulaChanged;
}
export function splitDraftParagraph(document: Note, blockId: string, position: number): string {
  const n = ensurePageModel(document), block = n.blocks.find(b => b.id === blockId); if (!block || block.type !== 'paragraph') throw new Error('请先选择文字段落');
  const text = editableBlockText(n, block); if (position <= 0 || position >= text.length) throw new Error('请把光标放在希望分段的位置');
  if (mathTokens(text).some(token => position > token.start && position < token.end)) throw new Error('请在行内公式之外分段，保持公式完整');
  const left: InlineRun[] = [], right: InlineRun[] = []; let cursor = 0;
  for (const run of block.content.runs || []) { const length = run.type === 'text' ? run.text.length : (n.formulas.find(f => f.id === run.formulaId)?.latex.length || 0) + 2; if (cursor + length <= position) left.push(structuredClone(run)); else if (cursor >= position) right.push(structuredClone(run)); else if (run.type === 'text') { left.push({ type: 'text', text: run.text.slice(0, position - cursor) }); right.push({ type: 'text', text: run.text.slice(position - cursor) }); } else throw new Error('不能在公式内部拆分'); cursor += length; }
  const created = createParagraphBlock(n, '', block.pageId);
  updateBlock(n, created.id, { content: { ...block.content, runs: right }, sourceRefIds: [...block.sourceRefIds], needsReview: block.needsReview, ...(block.uncertainties ? { uncertainties: [...block.uncertainties] } : {}) });
  updateBlock(n, block.id, { content: { ...block.content, runs: left } });
  const page = n.pages.find(p => p.id === block.pageId)!; moveBlock(n, created.id, page.blockOrder.indexOf(block.id) + 1 - page.blockOrder.indexOf(created.id)); return created.id;
}
export function mergeDraftParagraphs(document: Note, firstId: string, secondId: string): void { const n = ensurePageModel(document), first = n.blocks.find(b => b.id === firstId), second = n.blocks.find(b => b.id === secondId); if (!first || !second || first.type !== 'paragraph' || second.type !== 'paragraph' || first.pageId !== second.pageId) throw new Error('只能合并同页相邻段落'); const order = n.pages.find(p => p.id === first.pageId)!.blockOrder; if (order.indexOf(secondId) !== order.indexOf(firstId) + 1) throw new Error('只能合并相邻段落'); updateBlock(n, first.id, { content: { ...first.content, runs: [...(first.content.runs || []), { type: 'text', text: '\n' }, ...(second.content.runs || [])] }, sourceRefIds: [...new Set([...first.sourceRefIds, ...second.sourceRefIds])], needsReview: first.needsReview || second.needsReview }); removeBlock(n, second.id); }
