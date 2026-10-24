import type { Formula, Note } from './model.ts';

/** Inline history remains available for undo, but is not a current visible formula. */
export function activeFormulas(note: Note): Formula[] {
  if (!Array.isArray(note.blocks)) return note.formulas;
  const referenced = new Set(note.blocks.flatMap(block => [...(block.content.formulaId ? [block.content.formulaId] : []), ...(block.content.runs || []).filter(run => run.type === 'formula').map(run => run.formulaId)]));
  return note.formulas.filter(formula => !formula.inline || referenced.has(formula.id));
}
