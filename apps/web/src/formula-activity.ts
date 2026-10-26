import type { Formula, Note } from './model.ts';
import { orderedBlocks } from './page-model.ts';

/** Inline history remains available for undo, but is not a current visible formula. */
export function activeFormulas(note: Note): Formula[] {
  if (!Array.isArray(note.blocks)) return note.formulas;
  const referenced = new Set(orderedBlocks(note).flatMap(block => [...(block.content.formulaId ? [block.content.formulaId] : []), ...(block.content.runs || []).filter(run => run.type === 'formula').map(run => run.formulaId)]));
  return note.formulas.filter(formula => referenced.has(formula.id));
}
