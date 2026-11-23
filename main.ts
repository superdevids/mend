// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- files, lines, tiers (sections 3 and 5)

interface FileText {
  lines: string[];
  final: boolean;
  br: string;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], final: false, br: '\n' };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, final, br };
}

function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function lead(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');

function sameTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return strip(a) === strip(b);
}

/** The 0-based positions where O occurs, at one tier. */
function occurrences(fileLines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  const last = fileLines.length - old.length;
  for (let i = 0; i <= last; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!sameTier(fileLines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence, and its positions; strict: tier 0 only. */
function findTier(fileLines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(fileLines, old, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

type LineKind = 'ctx' | 'minus' | 'plus';

interface BodyLine {
  kind: LineKind;
  text: string;
  noEOL: boolean;
}

/** N's lines as written, given where O matched: context takes the file's own line, tier 2 re-indents. */
function renderNew(n: BodyLine[], o: BodyLine[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const first = fileLines[at] ?? '';
  const from = lead(o[0]?.text ?? '');
  const to = lead(first);
  let ctxSeen = 0;
  for (const line of n) {
    if (line.kind === 'ctx') {
      let idx = -1;
      let seen = 0;
      for (let j = 0; j < o.length; j += 1) {
        if (o[j]!.kind === 'ctx') {
          if (seen === ctxSeen) {
            idx = j;
            break;
          }
          seen += 1;
        }
      }
      ctxSeen += 1;
      out.push(idx >= 0 ? (fileLines[at + idx] ?? line.text) : line.text);
      continue;
    }
    let t = line.text;
    if (tier === 2 && t !== '' && strip(t) !== '') {
      if (from !== '' && t.startsWith(from)) t = to + t.slice(from.length);
      else if (from === '') t = to + t;
    }
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function gitForm(l: string): { a: string; b: string } | null {
  const m = /^diff --git (\S+) (\S+)$/.exec(l);
  if (m === null) return null;
  if (!m[1]!.startsWith('a/') || !m[2]!.startsWith('b/')) return null;
  return { a: m[1]!.slice(2), b: m[2]!.slice(2) };
}

/** The path on a `--- ` or `+++ ` line: after the four characters, up to a tab, trimmed. */
function headerPath(l: string): string {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return '';
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let cur: Section | null = null;
  let headerOpen = false;
  let oldFromPair = false;

  const push = (): void => {
    if (cur === null) return;
    const s = cur;
    cur = null;
    headerOpen = false;
    oldFromPair = false;
    if (s.oldPath === null && s.newPath === null) return;
    edits.push((tree) => applySection(tree, s, strict));
  };

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = gitForm(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      push();
      cur = { oldPath: g.a, newPath: g.b, isNew: false, isDel: false, hunks: [] };
      headerOpen = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !headerOpen || oldFromPair) push();
      if (cur === null) {
        cur = { oldPath: null, newPath: null, isNew: false, isDel: false, hunks: [] };
        headerOpen = true;
      }
      const s = cur as Section;
      const o = headerPath(l);
      const n = headerPath(lines[i + 1]!);
      s.oldPath = o === '' ? null : o;
      s.newPath = n === '' ? null : n;
      oldFromPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = cur as Section;
      headerOpen = false;
      const a = Number(m[1]);
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: 'ctx', text: '', noEOL: false });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') body.push({ kind: 'ctx', text: b.slice(1), noEOL: false });
        else if (c === '-') body.push({ kind: 'minus', text: b.slice(1), noEOL: false });
        else if (c === '+') body.push({ kind: 'plus', text: b.slice(1), noEOL: false });
        else if (c === '\\') {
          const prev = body[body.length - 1];
          if (prev !== undefined) prev.noEOL = true;
          i += 1;
          continue;
        } else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      s.hunks.push({ a, body });
      continue;
    }
    if (cur !== null && headerOpen) {
      const s = cur as Section;
      if (l.startsWith('rename from ')) {
        s.oldPath = l.slice('rename from '.length).replace(/^ +| +$/g, '');
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        s.newPath = l.slice('rename to '.length).replace(/^ +| +$/g, '');
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        s.isNew = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        s.isDel = true;
        i += 1;
        continue;
      }
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    i += 1;
  }
  push();
  return edits;
}

function applySection(tree: Tree, s: Section, strict: boolean): void {
  const oldP = s.oldPath;
  const newP = s.newPath;
  const creation = s.isNew || oldP === null;
  const deletion = s.isDel || newP === null;

  if (creation && !deletion) {
    const p = newP as string;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const out: string[] = [];
    let final = true;
    for (const h of s.hunks) for (const bl of h.body) if (bl.kind === 'plus') out.push(bl.text);
    const lastHunk = s.hunks[s.hunks.length - 1];
    if (lastHunk !== undefined) {
      for (let j = lastHunk.body.length - 1; j >= 0; j -= 1) {
        const bl = lastHunk.body[j]!;
        if (bl.kind === 'plus' || bl.kind === 'ctx') {
          if (bl.noEOL) final = false;
          break;
        }
      }
    }
    tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
    return;
  }

  if (deletion) {
    const p = oldP as string;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }

  const from = oldP as string;
  const to = newP as string;
  const move = from !== to;
  if (move) {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (!safe(to)) throw new Fail('unsafe', to);
    if (tree.get(from) === null) throw new Fail('missing', from);
    if (tree.get(to) !== null) throw new Fail('exists', to);
  } else if (!safe(from)) throw new Fail('unsafe', from);
  const before = tree.get(from);
  if (before === null) throw new Fail('missing', from);

  const f = parseFile(before);
  let d = 0;
  for (const h of s.hunks) {
    const o = h.body.filter((b) => b.kind !== 'plus');
    const n = h.body.filter((b) => b.kind !== 'minus');
    const target = h.a - 1 + d;
    let at: number;
    let tier = 0;
    if (o.length === 0) {
      at = Math.min(Math.max(h.a + d, 0), f.lines.length);
    } else {
      const found = findTier(f.lines, o.map((b) => b.text), strict);
      if (found === null) throw new Fail('no-match', from);
      tier = found.tier;
      let best = found.at[0]!;
      let bestD = Math.abs(best - target);
      for (const p of found.at) {
        const dd = Math.abs(p - target);
        if (dd < bestD) {
          best = p;
          bestD = dd;
        }
      }
      at = best;
    }
    const written = o.length === 0 ? n.map((b) => b.text) : renderNew(n, o, f.lines, at, tier);
    const reachedEnd = o.length === 0 ? at >= f.lines.length : at + o.length >= f.lines.length;
    f.lines = [...f.lines.slice(0, at), ...written, ...f.lines.slice(at + o.length)];
    if (reachedEnd) {
      let final = true;
      for (let j = h.body.length - 1; j >= 0; j -= 1) {
        const bl = h.body[j]!;
        if (bl.kind !== 'minus') {
          if (bl.noEOL) final = false;
          break;
        }
      }
      f.final = final;
    }
    d += n.length - o.length;
  }

  const text = renderFile(f);
  if (move) {
    tree.now.set(to, text);
    tree.now.set(from, null);
    tree.moves.push({ old: from, to });
  } else {
    tree.now.set(from, text);
  }
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.replace(/[ \t]+$/, '') !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.replace(/^[ \t]+|[ \t]+$/g, '');
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);

    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j]!.replace(/[ \t]+$/, '');
      if (l === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine + 1}`);
      if (l === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);

    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => applyBlock(tree, p, oldLines, newLines, strict));
    lastPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function applyBlock(tree: Tree, p: string, oldLines: string[], newLines: string[], strict: boolean): void {
  if (oldLines.length === 0) {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    return;
  }
  if (!safe(p)) throw new Fail('unsafe', p);
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  const f = parseFile(before);
  const found = findTier(f.lines, oldLines, strict);
  if (found === null) throw new Fail('no-match', p);
  if (found.at.length > 1) throw new Fail('ambiguous', p);
  const at = found.at[0]!;
  const o: BodyLine[] = oldLines.map((t) => ({ kind: 'ctx' as LineKind, text: t, noEOL: false }));
  const n: BodyLine[] = newLines.map((t) => ({ kind: 'plus' as LineKind, text: t, noEOL: false }));
  const written = renderNew(n, o, f.lines, at, found.tier);
  f.lines = [...f.lines.slice(0, at), ...written, ...f.lines.slice(at + oldLines.length)];
  tree.now.set(p, renderFile(f));
}

// ---------------------------------------------------------------- V4A (section 8)

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  chunks: V4AChunk[];
  added: string[];
  line: number;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.replace(/^[ \t]+|[ \t]+$/g, '') !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.replace(/^[ \t]+|[ \t]+$/g, '') !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  const body = lines.slice(first + 1, last);
  const base = first + 1;
  let i = 0;
  let cur: V4ASection | null = null;

  const finish = (): void => {
    if (cur === null) return;
    const s = cur;
    cur = null;
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.line}`);
    sections.push(s);
  };

  while (i < body.length) {
    const l = body[i]!;
    const n = base + i + 1;
    if (l.startsWith('*** Add File: ')) {
      finish();
      cur = { kind: 'add', path: l.slice('*** Add File: '.length).replace(/^ +| +$/g, ''), moveTo: null, chunks: [], added: [], line: n };
      i += 1;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      finish();
      cur = { kind: 'del', path: l.slice('*** Delete File: '.length).replace(/^ +| +$/g, ''), moveTo: null, chunks: [], added: [], line: n };
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      finish();
      cur = { kind: 'upd', path: l.slice('*** Update File: '.length).replace(/^ +| +$/g, ''), moveTo: null, chunks: [], added: [], line: n };
      i += 1;
      continue;
    }
    if (cur === null) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${n}`);
    }
    const s = cur as V4ASection;
    if (s.kind === 'add') {
      if (l.startsWith('+')) s.added.push(l.slice(1));
      else if (blank(l)) s.added.push('');
      else throw new Exit2(`error: parse ${n}`);
      i += 1;
      continue;
    }
    if (s.kind === 'del') {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${n}`);
    }
    if (s.chunks.length === 0 && s.moveTo === null && l.startsWith('*** Move to: ')) {
      s.moveTo = l.slice('*** Move to: '.length).replace(/^ +| +$/g, '');
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).replace(/^ +| +$/g, '');
      s.chunks.push({ anchor: anchor === '' ? null : anchor, eof: false, body: [] });
      i += 1;
      continue;
    }
    if (l.startsWith('*** End of File')) {
      const ck = s.chunks[s.chunks.length - 1];
      if (ck === undefined) throw new Exit2(`error: parse ${n}`);
      ck.eof = true;
      i += 1;
      continue;
    }
    const c = l[0];
    if (s.chunks.length === 0) {
      if (c === ' ' || c === '-' || c === '+' || l === '') s.chunks.push({ anchor: null, eof: false, body: [] });
      else if (blank(l)) {
        i += 1;
        continue;
      } else throw new Exit2(`error: parse ${n}`);
    }
    const ck = s.chunks[s.chunks.length - 1]!;
    if (l === '') ck.body.push({ kind: 'ctx', text: '', noEOL: false });
    else if (c === ' ') ck.body.push({ kind: 'ctx', text: l.slice(1), noEOL: false });
    else if (c === '-') ck.body.push({ kind: 'minus', text: l.slice(1), noEOL: false });
    else if (c === '+') ck.body.push({ kind: 'plus', text: l.slice(1), noEOL: false });
    else if (blank(l)) {
      i += 1;
      continue;
    } else throw new Exit2(`error: parse ${n}`);
    i += 1;
  }
  finish();
  for (const s of sections) {
    for (const c of s.chunks) {
      while (c.body.length > 0) {
        const last = c.body[c.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') c.body.pop();
        else break;
      }
    }
  }
  return sections.map((s) => (tree: Tree) => applyV4A(tree, s, strict));
}

function applyV4A(tree: Tree, s: V4ASection, strict: boolean): void {
  if (s.kind === 'add') {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
    tree.now.set(s.path, s.added.length === 0 ? '' : s.added.join('\n') + '\n');
    return;
  }
  if (s.kind === 'del') {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (tree.get(s.path) === null) throw new Fail('missing', s.path);
    tree.now.set(s.path, null);
    return;
  }
  if (!safe(s.path)) throw new Fail('unsafe', s.path);
  if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
  const before = tree.get(s.path);
  if (before === null) throw new Fail('missing', s.path);
  if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
  const f = parseFile(before);
  let cursor = 0;
  for (const chunk of s.chunks) {
    if (chunk.anchor !== null) {
      let at = -1;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        for (let p = cursor; p < f.lines.length; p += 1) {
          if (sameTier(f.lines[p]!, chunk.anchor, tier)) {
            at = p;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', s.path);
      cursor = at + 1;
    }
    const o = chunk.body.filter((b) => b.kind !== 'plus');
    const n = chunk.body.filter((b) => b.kind !== 'minus');
    let at: number;
    let tier = 0;
    if (o.length === 0) {
      at = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
    } else {
      const old = o.map((b) => b.text);
      let found: { tier: number; at: number } | null = null;
      for (const t of strict ? [0] : [0, 1, 2]) {
        for (let p = cursor; p + old.length <= f.lines.length; p += 1) {
          if (chunk.eof && p + old.length !== f.lines.length) continue;
          let ok = true;
          for (let j = 0; j < old.length; j += 1) {
            if (!sameTier(f.lines[p + j]!, old[j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            found = { tier: t, at: p };
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new Fail('no-match', s.path);
      at = found.at;
      tier = found.tier;
    }
    const written = o.length === 0 ? n.map((b) => b.text) : renderNew(n, o, f.lines, at, tier);
    f.lines = [...f.lines.slice(0, at), ...written, ...f.lines.slice(at + o.length)];
    cursor = at + written.length;
  }
  if (s.moveTo !== null) {
    tree.now.set(s.moveTo, renderFile(f));
    tree.now.set(s.path, null);
    tree.moves.push({ old: s.path, to: s.moveTo });
  } else {
    tree.now.set(s.path, renderFile(f));
  }
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- the CLI (sections 1, 2 and 10)

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const movedTo = new Map<string, string>();
  const movedFrom = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      movedTo.set(m.to, m.old);
      movedFrom.add(m.old);
    }
  }
  const rows: { key: string; line: string }[] = [];
  const paths = [...new Set([...tree.now.keys(), ...movedTo.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of paths) {
    if (movedFrom.has(p)) continue;
    const old = movedTo.get(p);
    if (old !== undefined) {
      const now = tree.get(p)!;
      rows.push({ key: p, line: `R ${old} -> ${p}` });
      if (check) continue;
      rmSync(old, { force: true });
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
      continue;
    }
    if (!tree.now.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
