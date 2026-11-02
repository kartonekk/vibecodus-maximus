'use strict';
// Shared by the Claude Code hook CLI and the VS Code extension.
//
// Model: the working tree only ever holds code the user typed. Claude's version of a
// file lives in .ghost/files/<rel> ("the draft"). During a Claude turn the drafts are
// swapped onto disk so Claude (and its tests/greps) sees a consistent world; the user's
// real files are parked in .ghost/user/<rel> and restored when the turn stops.
//
// Tools without hooks (Cursor, Codex, Aider…) go through mark/ghostify instead: snapshot
// the working tree as a git tree, let the tool run, then turn everything it changed into drafts.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = '.ghost';
const EXCLUDE = new Set([DIR, '.git', '.claude', 'node_modules']);

function paths(root) {
  const g = path.join(root, DIR);
  return {
    dir: g,
    files: path.join(g, 'files'),
    user: path.join(g, 'user'),
    active: path.join(g, 'active.json'),
    off: path.join(g, 'off'),
    mark: path.join(g, 'mark'),
    config: path.join(g, 'config.json'),
    log: path.join(g, 'error.log'),
  };
}

const exists = (p) => fs.existsSync(p);
const toFs = (base, rel) => path.join(base, ...rel.split('/'));

// ---- direct files: Claude's edits land as-is, nobody retypes docs or styles ----

const DEFAULT_DIRECT = ['*.md', '*.css'];

// Per repo, .ghost/config.json: { "direct": ["*.md", "*.css", "*.scss"] }
function config(root) {
  try {
    return { direct: DEFAULT_DIRECT, ...JSON.parse(fs.readFileSync(paths(root).config, 'utf8')) };
  } catch {
    return { direct: DEFAULT_DIRECT };
  }
}

// Tiny glob: `*` within a folder, `**/` across folders; a pattern without `/` matches the file name.
function globRe(pattern) {
  const body = pattern
    .split(/(\*\*\/|\*|\?)/)
    .map((t) => (t === '**/' ? '(?:.*/)?' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

function isDirect(root, rel) {
  const name = rel.split('/').pop();
  return config(root).direct.some((p) => globRe(p).test(p.includes('/') ? rel : name));
}

// Drafts of files that are direct now (e.g. made before the rule existed): put Claude's
// version in place and drop the draft. Returns the files applied.
function applyDirect(root) {
  if (isActive(root)) return [];
  const applied = listGhosts(root).filter((rel) => isDirect(root, rel));
  for (const rel of applied) {
    copyFile(ghostFile(root, rel), toFs(root, rel));
    rm(ghostFile(root, rel));
  }
  return applied;
}

function writeFile(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

// Fresh mtime on purpose: copyFileSync keeps the source's (old) mtime on Windows, and editors
// like VS Code ignore a change that looks older than what they have, leaving Claude's code on screen.
function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, fs.readFileSync(from));
}

function rm(p) {
  fs.rmSync(p, { force: true, recursive: true });
}

// Closest folder at or above `start` that is a ghost root (.ghost) or a git repo (.git), else null.
// Drafts always live in the edited file's own repo, so sub-repos inside a bigger folder just work.
function closestRoot(start) {
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if (exists(path.join(d, DIR)) || exists(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

const findRoot = (start) => closestRoot(start) || path.resolve(start);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'venv', '__pycache__']);

// `base` and the folders below it (up to `depth` levels) that contain `marker`: ghost roots by
// default, or sub-repos with marker '.git'. Skips hidden and dependency folders.
function nestedRoots(base, { depth = 3, marker = DIR } = {}) {
  const out = [];
  const walk = (dir, left) => {
    if (exists(path.join(dir, marker))) out.push(dir);
    if (!left) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), left - 1);
    }
  };
  walk(path.resolve(base), depth);
  return out;
}

// Root whose .ghost holds a draft of `file` (nearest first), else null.
function ghostRootFor(file) {
  const abs = path.resolve(file);
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    if (exists(path.join(d, DIR))) {
      const rel = relOf(d, abs);
      if (rel && exists(ghostFile(d, rel))) return d;
    }
    if (path.dirname(d) === d) return null;
  }
}

// Keep .ghost/ out of `git status` in repos nobody ran install in: local exclude, nothing tracked.
function ensureIgnored(root) {
  try {
    git(root, ['check-ignore', '-q', '--no-index', `${DIR}/`]);
    return; // already ignored
  } catch {}
  try {
    const ex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
    fs.mkdirSync(path.dirname(ex), { recursive: true });
    fs.appendFileSync(ex, `\n${DIR}/\n`);
  } catch {} // not a git repo: nothing to keep clean
}

// Project-relative path with forward slashes, or null when the file must not be ghosted.
function relOf(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const norm = rel.split(path.sep).join('/');
  if (EXCLUDE.has(norm.split('/')[0])) return null;
  return norm;
}

const ghostFile = (root, rel) => toFs(paths(root).files, rel);
const isActive = (root) => exists(paths(root).active);
const isOff = (root) => exists(paths(root).off);

function setOff(root, off) {
  const p = paths(root).off;
  if (off) writeFile(p, 'ghost mode disabled\n');
  else rm(p);
}

function readActive(root) {
  try {
    return JSON.parse(fs.readFileSync(paths(root).active, 'utf8'));
  } catch {
    return null;
  }
}

function listGhosts(root) {
  const base = paths(root).files;
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out.sort();
}

// Put Claude's draft of `rel` on disk for the rest of the turn. With `write`, also
// snapshot files without a draft, because Claude is about to modify them.
function swapIn(root, rel, { write = false } = {}) {
  if (isDirect(root, rel)) return false; // docs/styles: Claude writes them for real
  const p = paths(root);
  const act = readActive(root) || { started: new Date().toISOString(), files: {} };
  if (act.files[rel]) return false;
  const real = toFs(root, rel);
  const ghost = toFs(p.files, rel);
  const hasGhost = exists(ghost);
  if (!hasGhost && !write) return false;
  if (!exists(p.dir)) {
    fs.mkdirSync(p.dir, { recursive: true });
    ensureIgnored(root);
  }

  const existed = exists(real);
  if (existed) copyFile(real, toFs(p.user, rel));
  act.files[rel] = { existed };
  // Manifest first: if we die after this, swapOut can still put the user's file back.
  writeFile(p.active, JSON.stringify(act, null, 2));
  if (hasGhost) copyFile(ghost, real);
  return true;
}

function swapInAll(root) {
  return listGhosts(root).filter((rel) => swapIn(root, rel));
}

// End of turn: whatever Claude left on disk becomes the draft, the user's file comes back.
function swapOut(root) {
  const p = paths(root);
  const act = readActive(root);
  if (!act) return [];
  const drafted = [];
  for (const [rel, info] of Object.entries(act.files)) {
    const real = toFs(root, rel);
    const snap = toFs(p.user, rel);
    const ghost = toFs(p.files, rel);
    const claude = exists(real) ? fs.readFileSync(real, 'utf8') : null;
    const user = info.existed && exists(snap) ? fs.readFileSync(snap, 'utf8') : '';

    if (claude === null || sameCode(claude, user)) {
      rm(ghost);
    } else {
      writeFile(ghost, claude);
      drafted.push(rel);
    }

    if (info.existed && exists(snap)) copyFile(snap, real);
    else if (drafted.includes(rel)) writeFile(real, ''); // new file: empty canvas to type into
    else rm(real);
  }
  rm(p.user);
  rm(p.active);
  return drafted;
}

// ---- mark / ghostify (any tool, via git) ----

function git(root, args, { env, input, buffer } = {}) {
  return execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, ...env },
    input,
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Whole working tree (tracked + untracked, minus .gitignore'd) as a git tree object, built in
// a throwaway index so the real one is never touched.
//   raw: true   exact bytes (no autocrlf), fresh index; for mark, so restores are byte-identical
//   raw: false  normal git conversion, index seeded from the real one; comparable with HEAD
function snapshotTree(root, { raw }) {
  const idx = path.join(paths(root).dir, 'snap.index');
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  rm(idx);
  if (!raw) {
    const real = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
    if (exists(real)) fs.copyFileSync(real, idx);
  }
  const env = { GIT_INDEX_FILE: idx };
  const cfg = raw ? ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'] : [];
  try {
    git(root, [...cfg, 'add', '-A', '--', '.'], { env }); // .ghost paths, if not ignored, are skipped by relOf
    return git(root, ['write-tree'], { env }).trim();
  } finally {
    rm(idx);
  }
}

const readMark = (root) => (exists(paths(root).mark) ? fs.readFileSync(paths(root).mark, 'utf8').trim() : null);

function mark(root) {
  const tree = snapshotTree(root, { raw: true });
  writeFile(paths(root).mark, tree + '\n');
  return tree;
}

const unmark = (root) => rm(paths(root).mark);

function headTree(root) {
  try {
    return git(root, ['rev-parse', 'HEAD^{tree}']).trim();
  } catch {
    return git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim(); // no commits yet
  }
}

// Everything that changed since the mark (or HEAD) becomes a draft; the files go back to
// the baseline for you to type. Returns { base, drafted, skipped, direct }.
function ghostify(root) {
  if (isActive(root)) throw new Error('A Claude turn is running (or was interrupted). Wait, or run `out` first.');
  const marked = readMark(root);
  const base = marked || headTree(root);
  const cur = snapshotTree(root, { raw: !!marked });
  const out = git(root, ['diff', '--numstat', '-z', '--no-renames', '--relative', base, cur]);
  const drafted = [];
  const skipped = [];
  const direct = [];
  for (const entry of out.split('\0').filter(Boolean)) {
    const [added, , file] = entry.split('\t');
    const rel = relOf(root, file);
    if (!rel) continue;
    if (added === '-') {
      skipped.push(rel); // binary: can't be typed, leave the tool's version
      continue;
    }
    if (isDirect(root, rel)) {
      direct.push(rel); // docs/styles: keep the tool's version
      continue;
    }
    let before = null;
    try {
      // mark blobs are raw bytes; HEAD blobs are normalized, so run them through autocrlf/smudge
      const how = marked ? ['blob'] : ['--filters'];
      before = git(root, ['cat-file', ...how, `${base}:./${rel}`], { buffer: true });
    } catch {}
    const real = toFs(root, rel);
    const after = exists(real) ? fs.readFileSync(real, 'utf8') : ''; // deleted: draft is empty
    if (sameCode(after, before ? before.toString('utf8') : '')) continue;
    writeFile(real, before || ''); // new file: empty canvas to type into
    writeFile(ghostFile(root, rel), after);
    drafted.push(rel);
  }
  unmark(root);
  return { base: marked ? 'mark' : 'HEAD', drafted, skipped, direct };
}

// ---- line alignment (pure, used for rendering and progress) ----

const splitLines = (text) => text.split(/\r?\n/);
const key = (line) => line.trim();

function sameCode(a, b) {
  const norm = (t) => splitLines(t).map(key).join('\n').trim();
  return norm(a) === norm(b);
}

// Align the user's lines with the draft's lines. Ops:
//   {t:'eq', u, g}        identical (ignoring surrounding whitespace)
//   {t:'pair', u, g}      user line u is the user's attempt at draft line g
//   {t:'ins', from, to, at} draft lines [from,to) not started yet; `at` = user line above (-1 = top)
//   {t:'extra', u}        user line the draft does not have
function align(u, g) {
  const ku = u.map(key);
  const kg = g.map(key);
  const ops = [];

  // Trim the common head/tail, stopping at blank lines (see lcs).
  let s = 0;
  while (s < u.length && s < g.length && ku[s] && ku[s] === kg[s]) ops.push({ t: 'eq', u: s, g: s++ });
  let eu = u.length;
  let eg = g.length;
  const tail = [];
  while (eu > s && eg > s && ku[eu - 1] && ku[eu - 1] === kg[eg - 1]) tail.unshift({ t: 'eq', u: --eu, g: --eg });

  const matches = lcs(ku, kg, s, eu, s, eg);
  let ui = s;
  let gi = s;
  for (const [a, b] of [...matches, [eu, eg]]) {
    hunk(ops, ui, a, gi, b);
    if (a < eu) ops.push({ t: 'eq', u: a, g: b });
    ui = a + 1;
    gi = b + 1;
  }
  return ops.concat(tail);
}

function hunk(ops, us, ue, gs, ge) {
  const k = Math.min(ue - us, ge - gs);
  for (let j = 0; j < k; j++) ops.push({ t: 'pair', u: us + j, g: gs + j });
  if (ge - gs > k) ops.push({ t: 'ins', from: gs + k, to: ge, at: us + k - 1 });
  for (let j = us + k; j < ue; j++) ops.push({ t: 'extra', u: j });
}

// LCS over the middle section. Blank lines never anchor, so a fresh empty line the user
// just opened pairs with the next draft line instead of some blank line further down.
function lcs(ku, kg, us, ue, gs, ge) {
  const n = ue - us;
  const m = ge - gs;
  if (!n || !m || n * m > 4e6) return [];
  const W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const a = ku[us + i];
      L[i * W + j] =
        a !== '' && a === kg[gs + j]
          ? L[(i + 1) * W + j + 1] + 1
          : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const out = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    const a = ku[us + i];
    if (a !== '' && a === kg[gs + j]) out.push([us + i++, gs + j++]);
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
    else j++;
  }
  return out;
}

// How far is the user's line from the draft's line?
//   eq        done
//   suffix    on track; `text` is what's left to type, at column `at` of the user's line
//   mismatch  user typed something else from column `col`
function lineDiff(user, draft) {
  const ut = user.trimStart();
  const dt = draft.trimStart();
  const lead = user.length - ut.length;
  if (ut.trimEnd() === dt.trimEnd()) return { kind: 'eq' };
  if (dt.startsWith(ut)) return { kind: 'suffix', text: user === '' ? draft : dt.slice(ut.length), at: user.length };
  const ue = ut.trimEnd();
  const de = dt.trimEnd();
  let k = 0;
  while (k < ue.length && ue[k] === de[k]) k++;
  // Start and end typed with a gap between: the editor auto-closed a quote or bracket
  // (`"abc|"` while the draft has `"abcdef"`). The middle is left to type, at the gap.
  for (let i = k; i >= 0; i--) {
    const tail = ue.slice(i);
    if (tail && de.length - tail.length > i && de.endsWith(tail)) {
      return { kind: 'suffix', text: de.slice(i, de.length - tail.length), at: lead + i };
    }
  }
  return { kind: 'mismatch', col: lead + k };
}

// Draft text to show as ghost text at the cursor: the rest of the current line plus the draft
// lines waiting right below it. null when nothing continues from here (or the user went off-draft).
function ghostAt(u, g, line, col, ops = align(u, g), maxLines = 80) {
  const text = u[line] ?? '';
  let head = '';
  let at = null;
  const below = [];
  for (const op of ops) {
    if (op.t === 'pair' && op.u === line) {
      const d = lineDiff(text, g[op.g]);
      if (d.kind === 'mismatch') return null;
      if (d.kind === 'suffix') [head, at] = [d.text, d.at];
    } else if (op.t === 'ins' && op.at === line) {
      below.push(...g.slice(op.from, op.to));
    }
  }
  // The cursor must sit where typing continues: at the gap / end of what's typed, or (nothing
  // left on this line) at its end.
  const tail = text.slice(col);
  if (head ? col !== at : tail.trim()) return null;
  const rest = below.slice(0, maxLines);
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop(); // no dangling empty ghost lines
  if (!head && !rest.length) return null;
  // Replacement for [col, end of line]: the auto-closed tail stays where it is.
  return head + tail + (rest.length ? '\n' + rest.join('\n') : '');
}

// Languages where a line starting with # is code (#id, #include), not a comment.
const HASH_IS_CODE = new Set(['css', 'scss', 'less', 'sass', 'html', 'c', 'cpp', 'csharp', 'objective-c', 'objective-cpp', 'markdown']);

// Languages where a line opening with """ or ''' is a docstring (elsewhere, e.g. Java/Kotlin, it's a text block: code).
const DOCSTRING_LANGS = new Set(['python']);

// Indexes of draft lines that are entirely a comment: /* … */ and /** … */ blocks and Python
// """ / ''' docstrings (every line of them), // lines, and # lines where # starts a comment.
// Those may be Tab-completed.
function commentLines(lines, lang = '') {
  const out = new Set();
  let close = null; // what ends the block we're in: '*/', '"""' or "'''"
  lines.forEach((line, i) => {
    const t = line.trim();
    if (close) {
      const end = t.indexOf(close);
      if (end === -1 || !t.slice(end + close.length).trim()) out.add(i);
      if (end !== -1) close = null;
      return;
    }
    const doc = DOCSTRING_LANGS.has(lang) && t.match(/^[rRuUbBfF]{0,2}("""|''')/);
    const open = t.startsWith('/*') ? { len: 2, end: '*/' } : doc ? { len: doc[0].length, end: doc[1] } : null;
    if (open) {
      const end = t.indexOf(open.end, open.len);
      if (end === -1) close = open.end;
      if (end === -1 || !t.slice(end + open.end.length).trim()) out.add(i);
    } else if (t.startsWith('//') || (t.startsWith('#') && !HASH_IS_CODE.has(lang))) {
      out.add(i);
    }
  });
  return out;
}

// What Tab fills in at the cursor. Only draft lines that are whole-line comments, one per Tab:
//   - the missing rest of the comment line you're on (at the cursor / gap)
//   - your line is blank or a comment but differs from the draft's comment line (Claude edited
//     an existing comment): swap in the draft's line, cursor at the end of yours
//   - at the end of a finished line with a comment due below it: newline + that comment line
// Returns { line, from, to, text }: replace columns [from, to) of user line `line` with `text`.
function tabFill(u, g, line, col, lang = '', ops = align(u, g)) {
  const comments = commentLines(g, lang);
  const text = u[line] ?? '';
  const pair = ops.find((op) => op.t === 'pair' && op.u === line);
  const d = pair && lineDiff(text, g[pair.g]);
  if (pair && d.kind !== 'eq') {
    if (!comments.has(pair.g)) return null; // unfinished code line: type it
    // blank / indentation-only line: the whole comment line, wherever the cursor is in it
    if (!text.trim()) return { line, from: 0, to: text.length, text: g[pair.g] };
    if (d.kind === 'suffix' && col === d.at) return { line, from: col, to: col, text: d.text };
    if (col >= text.trimEnd().length && commentLines(u, lang).has(line)) return { line, from: 0, to: text.length, text: g[pair.g] };
    return null;
  }
  if (text.slice(col).trim()) return null;
  const ins = ops.find((op) => op.t === 'ins' && op.at === line);
  if (!ins) {
    // The comment is due on the empty line right below (often the file's final newline, which the
    // alignment pairs with the next draft line): put it in under the cursor, keep that empty line.
    const below = ops.find((op) => op.t === 'pair' && op.u === line + 1);
    if (below && !(u[line + 1] || '').trim() && comments.has(below.g)) {
      return { line, from: text.length, to: text.length, text: '\n' + g[below.g] };
    }
    return null;
  }
  const first = g.slice(ins.from, ins.to).findIndex((l) => l.trim());
  if (first === -1 || !comments.has(ins.from + first)) return null;
  // blank draft lines before it come along (nothing to type there)
  return { line, from: text.length, to: text.length, text: '\n'.repeat(first + 1) + g[ins.from + first] };
}

// Does this op still need typing (vs. blank noise / already-matching pairs)?
function isLive(op, u, g) {
  if (op.t === 'eq') return false;
  if (op.t === 'pair') return lineDiff(u[op.u], g[op.g]).kind !== 'eq';
  if (op.t === 'ins') return g.slice(op.from, op.to).some(key);
  return !!key(u[op.u]);
}

// Group live ops into contiguous ghost parts:
//   lens       user line the part starts at (where "Ask Claude" sits above it)
//   start/end  user lines the part covers
//   gFrom/gTo  draft lines [gFrom, gTo) of the part, null when the part is only deletions
function hunks(u, g, ops = align(u, g)) {
  const out = [];
  let cur = null;
  for (const op of ops) {
    if (!isLive(op, u, g)) {
      cur = null;
      continue;
    }
    const line = op.t === 'ins' ? Math.max(op.at, 0) : op.u;
    if (!cur) {
      const lens = op.t === 'ins' ? Math.min(op.at + 1, u.length - 1) : op.u;
      cur = { lens, start: line, end: line, gFrom: null, gTo: null };
      out.push(cur);
    }
    cur.end = Math.max(cur.end, line);
    const [from, to] = op.t === 'pair' ? [op.g, op.g + 1] : op.t === 'ins' ? [op.from, op.to] : [];
    if (from !== undefined) {
      cur.gFrom = cur.gFrom === null ? from : Math.min(cur.gFrom, from);
      cur.gTo = cur.gTo === null ? to : Math.max(cur.gTo, to);
    }
  }
  return out;
}

// Part a given user line belongs to, else the nearest one.
function hunkAt(list, line) {
  const inside = list.find((h) => line >= Math.min(h.lens - 1, h.start) && line <= Math.max(h.end, h.lens));
  if (inside) return inside;
  return list.reduce((best, h) => (!best || Math.abs(h.lens - line) < Math.abs(best.lens - line) ? h : best), null);
}

// Lines still to type, out of the draft's non-blank lines.
function progress(userLines, ghostLines, ops = align(userLines, ghostLines)) {
  let pending = 0;
  for (const op of ops) {
    if (op.t === 'pair' && lineDiff(userLines[op.u], ghostLines[op.g]).kind !== 'eq') pending++;
    else if (op.t === 'ins') pending += ghostLines.slice(op.from, op.to).filter((l) => key(l)).length;
    else if (op.t === 'extra' && key(userLines[op.u])) pending++;
  }
  const total = ghostLines.filter((l) => key(l)).length;
  return { pending, total, done: pending === 0 };
}

function fileProgress(root, rel) {
  const real = toFs(root, rel);
  const user = exists(real) ? fs.readFileSync(real, 'utf8') : '';
  const ghost = fs.readFileSync(ghostFile(root, rel), 'utf8');
  return progress(splitLines(user), splitLines(ghost));
}

function logError(root, err) {
  try {
    fs.appendFileSync(paths(root).log, `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`);
  } catch {}
}

module.exports = {
  DIR,
  paths,
  config,
  isDirect,
  applyDirect,
  closestRoot,
  findRoot,
  nestedRoots,
  ghostRootFor,
  ensureIgnored,
  relOf,
  ghostFile,
  isActive,
  isOff,
  setOff,
  readActive,
  listGhosts,
  swapIn,
  swapInAll,
  swapOut,
  readMark,
  mark,
  unmark,
  ghostify,
  splitLines,
  sameCode,
  align,
  lineDiff,
  ghostAt,
  commentLines,
  tabFill,
  isLive,
  hunks,
  hunkAt,
  progress,
  fileProgress,
  logError,
};
