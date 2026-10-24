import type { Note } from './model.ts';
import type { SourceRef } from './page-model.ts';

export interface SourceCopyProof { version: 1; sourceRefId: string; sourceIdentity: string; manuscriptSha256: string; capturedAt: string }
const canonical = (value: unknown): string => { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`; return JSON.stringify(value); };
const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
/** SHA-256 fallback is needed on LAN HTTP, where SubtleCrypto is unavailable. */
export function manuscriptDigest(text: string): string {
  const bytes = new TextEncoder().encode(text), padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64); padded.set(bytes); padded[bytes.length] = 128;
  const view = new DataView(padded.buffer), bits = BigInt(bytes.length) * 8n; view.setUint32(padded.length - 8, Number(bits >> 32n)); view.setUint32(padded.length - 4, Number(bits & 0xffffffffn));
  const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], words = new Uint32Array(64);
  const rotate = (n: number, b: number) => n >>> b | n << 32 - b;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) { const a = words[i-15], b = words[i-2], s0 = rotate(a,7) ^ rotate(a,18) ^ a >>> 3, s1 = rotate(b,17) ^ rotate(b,19) ^ b >>> 10; words[i] = words[i-16] + s0 + words[i-7] + s1; }
    let [a,b,c,d,e,f,g,h] = state;
    for (let i = 0; i < 64; i++) { const s1 = rotate(e,6) ^ rotate(e,11) ^ rotate(e,25), choice = e & f ^ ~e & g, t1 = h + s1 + choice + constants[i] + words[i], s0 = rotate(a,2) ^ rotate(a,13) ^ rotate(a,22), majority = a & b ^ a & c ^ b & c, t2 = s0 + majority; h=g;g=f;f=e;e=d+t1|0;d=c;c=b;b=a;a=t1+t2|0; }
    for (const [i,v] of [a,b,c,d,e,f,g,h].entries()) state[i] = state[i] + v | 0;
  }
  return state.map(n => (n >>> 0).toString(16).padStart(8,'0')).join('');
}
function manuscript(note: Note): string { return canonical({ revision: note.revision, strokes: note.strokes, butterflyData: note.butterflyData || null, butterflyPageRevisions: note.butterflyPageRevisions || null, butterflyContentRevisions: note.butterflyContentRevisions || null }); }
function sourceVersionMatches(note: Note, source: SourceRef): boolean {
  if (source.kind !== 'ink' || source.sourceRevision !== note.revision || !note.pages?.some(page => page.nativePageId === source.nativePageId)) return false;
  const butterfly = !!source.nativeInkRevision || source.nativePageId !== 'default' || !!source.nativeRevision && !/^\d+$/.test(source.nativeRevision);
  if (butterfly) return !!note.butterflyData?.length && !!source.nativeRevision && note.butterflyContentRevisions?.[source.nativePageId] === source.nativeRevision && (!source.nativeInkRevision || note.butterflyPageRevisions?.[source.nativePageId] === source.nativeInkRevision);
  return source.strokeIds.length > 0 && source.strokeIds.every(id => note.strokes.some(stroke => stroke.id === id)) && (!source.nativeRevision || source.nativeRevision === String(note.revision));
}
/** Records a clone proof while the original is present; never changes original SourceRef identity. */
export function rememberSourceCopies(original: Note, draft: Note): void {
  const originalText = manuscript(original), copiedText = manuscript(draft);
  if (originalText !== copiedText) { draft.sourceCopyProofs = []; return; }
  const fingerprint = manuscriptDigest(copiedText), sourceIdentity = (source: SourceRef) => canonical(source);
  const inherited = (draft.sourceCopyProofs || []).filter(proof => proof.manuscriptSha256 === fingerprint && draft.sources?.some(source => source.id === proof.sourceRefId && sourceIdentity(source) === proof.sourceIdentity && sourceVersionMatches(draft,source)));
  const proofs = new Map(inherited.map(proof => [proof.sourceRefId, proof]));
  for (const source of draft.sources || []) if (source.noteId === original.id && original.sources?.some(s => s.id === source.id && sourceIdentity(s) === sourceIdentity(source)) && sourceVersionMatches(original,source)) proofs.set(source.id, { version: 1, sourceRefId: source.id, sourceIdentity: sourceIdentity(source), manuscriptSha256: fingerprint, capturedAt: new Date().toISOString() });
  draft.sourceCopyProofs = [...proofs.values()];
}
export function resolveSourceLocation(notes: Note[], current: Note, source: SourceRef): { note: Note; copy: boolean } | null {
  const original = notes.find(note => note.id === source.noteId); if (original) return { note: original, copy: false };
  const proof = current.sourceCopyProofs?.find(p => p.sourceRefId === source.id);
  if (!proof || proof.version !== 1 || proof.sourceIdentity !== canonical(source) || !sourceVersionMatches(current,source) || proof.manuscriptSha256 !== manuscriptDigest(manuscript(current))) return null;
  return { note: current, copy: true };
}
