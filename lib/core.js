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
    log: path.join(g, 'error.log'),
  };
}

const exists = (p) => fs.existsSync(p);
const toFs = (base, rel) => path.join(base, ...rel.split('/'));

function writeFile(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function rm(p) {
  fs.rmSync(p, { force: true, recursive: true });
}

// Walk up from `start` to the nearest folder holding .ghost, else .git, else `start`.
function findRoot(start) {
  let dir = path.resolve(start);
  for (const marker of [DIR, '.git']) {
    for (let d = dir; ; d = path.dirname(d)) {
      if (exists(path.join(d, marker))) return d;
      if (path.dirname(d) === d) break;
    }
  }
  return dir;
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
  const p = paths(root);
  const act = readActive(root) || { started: new Date().toISOString(), files: {} };
  if (act.files[rel]) return false;
  const real = toFs(root, rel);
  const ghost = toFs(p.files, rel);
  const hasGhost = exists(ghost);
  if (!hasGhost && !write) return false;

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
// the baseline for you to type. Returns { base, drafted, skipped }.
function ghostify(root) {
  if (isActive(root)) throw new Error('A Claude turn is running (or was interrupted). Wait, or run `out` first.');
  const marked = readMark(root);
  const base = marked || headTree(root);
  const cur = snapshotTree(root, { raw: !!marked });
  const out = git(root, ['diff', '--numstat', '-z', '--no-renames', '--relative', base, cur]);
  const drafted = [];
  const skipped = [];
  for (const entry of out.split('\0').filter(Boolean)) {
    const [added, , file] = entry.split('\t');
    const rel = relOf(root, file);
    if (!rel) continue;
    if (added === '-') {
      skipped.push(rel); // binary: can't be typed, leave the tool's version
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
  return { base: marked ? 'mark' : 'HEAD', drafted, skipped };
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
//   suffix    user typed a prefix; `text` is what's left to type
//   mismatch  user typed something else from column `col`
function lineDiff(user, draft) {
  const ut = user.trimStart();
  const dt = draft.trimStart();
  if (ut.trimEnd() === dt.trimEnd()) return { kind: 'eq' };
  if (dt.startsWith(ut)) return { kind: 'suffix', text: user === '' ? draft : dt.slice(ut.length) };
  let k = 0;
  while (k < ut.length && ut[k] === dt[k]) k++;
  return { kind: 'mismatch', col: user.length - ut.length + k };
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
  findRoot,
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
  isLive,
  hunks,
  hunkAt,
  progress,
  fileProgress,
  logError,
};
