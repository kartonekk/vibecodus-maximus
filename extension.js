'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/core');
const setup = require('./lib/install');

const SCHEME = 'vibeghost';
const DISABLED = 'vibeGhost.disabledFolders'; // globalState: folders the user switched off
const NBSP = ' ';

let deco;
let statusItem;
let comments;
let ctx; // ExtensionContext
let log = { info() {} }; // "Vibecodus Maximus" output channel (View > Output) once activated
let bin; // this extension's ghost.js, what the Claude hooks call
const lensChanged = new vscode.EventEmitter();
const cache = new Map(); // ghost file path -> { mtimeMs, lines, text }
const doneShown = new Set();
const threads = new WeakMap(); // CommentThread -> { context, history: [{q, a}], busy }

function makeDecorations() {
  const ghost = new vscode.ThemeColor('editorGhostText.foreground');
  return {
    suffix: vscode.window.createTextEditorDecorationType({
      after: { color: ghost },
      overviewRulerColor: ghost,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    insert: vscode.window.createTextEditorDecorationType({
      after: { color: ghost, fontStyle: 'italic', margin: '0 0 0 2ch' },
      overviewRulerColor: ghost,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    mismatch: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
      after: { color: ghost, margin: '0 0 0 2ch' },
      overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    extra: vscode.window.createTextEditorDecorationType({
      opacity: '0.45',
      textDecoration: 'line-through',
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
  };
}

function wsFolder(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder && folder.uri.fsPath;
}

// The repo a file belongs to (closest .ghost/.git), so sub-repos of an opened folder work.
function rootFor(uri) {
  return core.closestRoot(path.dirname(uri.fsPath)) || wsFolder(uri);
}

// Every repo / ghost root in the open folders, sub-repos included. Cached; the .ghost
// watcher and folder changes reset it.
let rootsCache = null;
function roots() {
  if (!rootsCache) {
    const set = new Set();
    for (const f of vscode.workspace.workspaceFolders || []) {
      for (const r of core.nestedRoots(f.uri.fsPath)) set.add(r);
      for (const r of setup.reposIn(f.uri.fsPath)) set.add(r);
    }
    rootsCache = [...set];
  }
  return rootsCache;
}

function readGhost(gp) {
  let stat;
  try {
    stat = fs.statSync(gp);
  } catch {
    cache.delete(gp);
    return null;
  }
  const hit = cache.get(gp);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
  const text = fs.readFileSync(gp, 'utf8');
  const entry = { mtimeMs: stat.mtimeMs, text, lines: core.splitLines(text) };
  cache.set(gp, entry);
  return entry;
}

// Draft info for a file, or null if it has none.
function ghostForUri(uri) {
  if (uri.scheme !== 'file') return null;
  const root = core.ghostRootFor(uri.fsPath);
  if (!root) return null;
  const rel = core.relOf(root, uri.fsPath);
  if (!rel) return null;
  const gp = core.ghostFile(root, rel);
  const g = readGhost(gp);
  return g && { root, rel, gp, ...g };
}
const ghostFor = (doc) => ghostForUri(doc.uri);

// Right after a Claude turn the buffer may still show Claude's code until VS Code reloads
// the restored file. Rendering then would mark the draft as "fully typed" and delete it.
function isStale(doc) {
  if (doc.isDirty) return false;
  // Line endings don't count: VS Code evens out a file's mixed CRLF/LF in the editor.
  const norm = (t) => t.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  try {
    return norm(fs.readFileSync(doc.uri.fsPath, 'utf8')) !== norm(doc.getText());
  } catch {
    return false;
  }
}

function show(text, tabSize) {
  return text.replace(/\t/g, NBSP.repeat(tabSize)).replace(/ /g, NBSP);
}

function clear(editor) {
  for (const d of Object.values(deco)) editor.setDecorations(d, []);
}

const inlineOn = () =>
  vscode.workspace.getConfiguration('vibeGhost').get('inlineGhost', true) &&
  vscode.workspace.getConfiguration('editor').get('inlineSuggest.enabled', true);

// Ghost text the inline provider shows at this editor's cursor, if any.
function cursorGhost(editor, user, g, ops) {
  if (!inlineOn() || editor !== vscode.window.activeTextEditor) return null;
  const pos = editor.selection.active;
  return core.ghostAt(user, g.lines, pos.line, pos.character, ops);
}

function render(editor) {
  const doc = editor.document;
  const g = ghostFor(doc);
  if (!g || core.isActive(g.root)) return clear(editor);
  if (isStale(doc)) {
    warnStale(doc, g);
    return clear(editor);
  }

  const tabSize = Number(editor.options.tabSize) || 4;
  const user = core.splitLines(doc.getText());
  const ops = core.align(user, g.lines);
  if (expandDraft(editor, user, g, ops)) return; // the buffer is about to change: render after that
  const out = { suffix: [], insert: [], mismatch: [], extra: [] };
  const lang = doc.languageId;
  // The cursor line gets real (multi-line) ghost text from the inline provider instead.
  const skipLine = inlineShowing && cursorGhost(editor, user, g, ops) ? editor.selection.active.line : -1;
  const cursorLines = new Set(editor.selections.map((s) => s.active.line));

  for (const op of ops) {
    if ((op.t === 'pair' && op.u === skipLine) || (op.t === 'ins' && op.at === skipLine)) continue;
    if (op.t === 'pair') {
      const u = user[op.u];
      const want = g.lines[op.g];
      let d = core.lineDiff(u, want);
      // Whole line typed plus closers the editor auto-inserted: fine while you're on it (Enter
      // moves them down), a stray bracket once you've left it.
      if (d.auto && !d.text && !cursorLines.has(op.u)) d = { kind: 'mismatch', col: d.at };
      if (d.kind === 'suffix') {
        // the gap before an auto-closed quote/bracket (plus any after it), or the end
        for (const part of [d, ...(d.more || [])]) {
          if (!part.text) continue;
          const end = new vscode.Position(op.u, part.at);
          out.suffix.push({
            range: new vscode.Range(end, end),
            renderOptions: { after: { contentText: show(part.text, tabSize) } },
          });
        }
      } else if (d.kind === 'mismatch') {
        out.mismatch.push({
          range: new vscode.Range(op.u, d.col, op.u, Math.max(u.length, d.col)),
          hoverMessage: md(lang, [want], 'Draft has:'),
          renderOptions: { after: { contentText: `👻 ${show(want.trim(), tabSize)}` } },
        });
      }
    } else if (op.t === 'ins') {
      const block = g.lines.slice(op.from, op.to);
      const firstReal = block.find((l) => l.trim());
      if (!firstReal) continue;
      const below = op.at >= 0;
      const line = Math.min(below ? op.at : 0, doc.lineCount - 1);
      const end = doc.lineAt(line).range.end;
      const n = block.filter((l) => l.trim()).length;
      out.insert.push({
        range: new vscode.Range(end, end),
        hoverMessage: md(lang, block, `${n} line(s) to type ${below ? 'below' : 'above'} this line:`),
        renderOptions: {
          after: { contentText: `👻 +${n} ${below ? '↓' : '↑'} ${show(firstReal.trim(), tabSize)}` },
        },
      });
    } else if (op.t === 'extra' && user[op.u].trim()) {
      out.extra.push({ range: doc.lineAt(op.u).range, hoverMessage: 'Not in Claude\'s draft — delete it yourself (or keep it, your call).' });
    }
  }

  for (const [k, list] of Object.entries(out)) editor.setDecorations(deco[k], list);

  const p = core.progress(user, g.lines, ops);
  if (p.done) finish(g);
}

// ---- every draft line on a line of its own ----
// VS Code can't put ghost lines between real ones (extensions get no virtual lines), so a block of
// new draft lines would only fit into a "+N lines" marker. Instead the buffer gets an empty line for
// every draft line not started yet, each showing its ghost in place; Enter just opens the next one
// (the leftover empty line goes). Only empty lines and indentation are ever touched. Right after a
// save the file stays as the save left it (trim/format on save) until you type again, and it's never
// more than a few rounds without you typing, so nothing can fight over the buffer.
const expandOn = () => vscode.workspace.getConfiguration('vibeGhost').get('expandDrafts', true);
const expandBusy = new Set(); // documents with our edit in flight
const expandRounds = new Map(); // document -> { mtime (of the draft), n: our edits since you typed }
const savedAt = new Map(); // document -> `${version}|${draft mtime}` right after a save
const typedAt = new Map(); // document -> its version right after you typed in it (in the active editor)
let layoutEdit = false; // our own edit: not typing, not a paste

function expandDraft(editor, user, g, ops) {
  const doc = editor.document;
  const id = doc.uri.toString();
  if (!expandOn() || expandBusy.has(id) || savedAt.get(id) === `${doc.version}|${g.mtimeMs}`) return false;
  const rounds = expandRounds.get(id);
  const n = rounds && rounds.mtime === g.mtimeMs ? rounds.n : 0;
  if (n >= 3) return false;
  const keep = new Set(editor.selections.map((s) => s.active.line));
  const typing = typedAt.get(id) === doc.version; // nothing changed since you typed: the cursor line is yours
  const edits = core.layout(user, g.lines, { keep, typed: typing ? keep : new Set() }, ops);
  if (!edits.length) return false;
  expandRounds.set(id, { mtime: g.mtimeMs, n: n + 1 });
  expandBusy.add(id);
  applyLayout(editor, edits)
    .catch((err) => log.info(`laying out ${doc.uri.fsPath} failed: ${err && err.message}`))
    .finally(() => {
      expandBusy.delete(id);
      scheduleRender();
    });
  return true;
}

// Ranges deleting whole lines (sorted line numbers), runs merged; at the end of the document the
// line break before the run goes with it.
function lineDeletes(doc, lines) {
  const out = [];
  const last = doc.lineCount - 1;
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    const [s, e] = [lines[i], lines[j]];
    if (e < last) out.push(new vscode.Range(s, 0, e + 1, 0));
    else if (s > 0) out.push(new vscode.Range(doc.lineAt(s - 1).range.end, doc.lineAt(e).range.end));
    i = j + 1;
  }
  return out;
}

async function applyLayout(editor, edits) {
  const doc = editor.document;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const last = doc.lineCount - 1;
  let appended = 0;
  layoutEdit = true;
  try {
    await editor.edit(
      (b) => {
        for (const e of edits) {
          if (e.t === 'insert' && e.before <= last) b.insert(new vscode.Position(e.before, 0), eol.repeat(e.count));
          else if (e.t === 'insert') {
            b.insert(doc.lineAt(last).range.end, eol.repeat(e.count));
            appended += e.count;
          } else if (e.t === 'indent') b.insert(new vscode.Position(e.line, 0), e.text);
        }
        const gone = edits.filter((e) => e.t === 'delete').map((e) => e.line).sort((a, b) => a - b);
        for (const r of lineDeletes(doc, gone)) b.delete(r);
      },
      { undoStopBefore: false, undoStopAfter: false } // undoing your last step takes ours along
    );
  } finally {
    layoutEdit = false;
  }
  // Lines added at the very end may have pushed a cursor sitting there down with them.
  if (appended) {
    const was = doc.lineAt(doc.lineCount - 1 - appended).range.end;
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    if (editor.selections.some((s) => s.active.isEqual(end))) {
      editor.selections = editor.selections.map((s) => (s.active.isEqual(end) ? new vscode.Selection(was, was) : s));
    }
  }
}

function md(lang, lines, title) {
  const m = new vscode.MarkdownString();
  m.appendText(`👻 ${title}\n`);
  m.appendCodeblock(lines.join('\n'), lang);
  return m;
}

// The editor still holds Claude's version while the disk has yours (e.g. a restore VS Code
// didn't pick up). Typing there or saving would make Claude's code yours, so say so loudly.
const staleWarned = new Set();
async function warnStale(doc, g) {
  if (staleWarned.has(g.gp)) return;
  staleWarned.add(g.gp);
  const pick = await vscode.window.showWarningMessage(
    `👻 The editor shows Claude's version of ${g.rel}, not yours. Don't save it. Reload your version from disk?`,
    'Reload'
  );
  staleWarned.delete(g.gp);
  if (pick !== 'Reload' || doc.isDirty) return;
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('workbench.action.files.revert');
}

// ---- real ghost text at the cursor (type over it) ----

const inlineGhost = {
  provideInlineCompletionItems(doc, position) {
    const editor = vscode.window.activeTextEditor;
    if (!inlineOn() || !editor || editor.document !== doc) return;
    const g = ghostFor(doc);
    if (!g || core.isActive(g.root) || isStale(doc)) return;
    const user = core.splitLines(doc.getText());
    const text = core.ghostAt(user, g.lines, position.line, position.character);
    if (!text) return;
    const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, doc.lineAt(position.line).range.end));
    // Accepting is cheating: if it ever happens (toolbar click etc.), undo it.
    item.command = { title: 'No', command: 'vibeGhost.rejectAccept' };
    return [item];
  },
};

// ---- which files still need typing: badge + color in Explorer and on tabs ----

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// A folder with unfinished drafts somewhere below it (the repo folder, apps/, apps/web/…):
// badge = how many files. null when `fsPath` isn't a folder, undefined for "no badge".
function folderBadge(fsPath) {
  try {
    if (!fs.statSync(fsPath).isDirectory()) return null;
  } catch {
    return null;
  }
  const root = core.closestRoot(fsPath);
  if (!root) return undefined;
  const rel = samePath(root, fsPath) ? '' : core.relOf(root, fsPath);
  if (rel === null) return undefined;
  if (!rel && core.isActive(root)) {
    return new vscode.FileDecoration('✍', '👻 Claude is writing in this repo right now', new vscode.ThemeColor('vibeGhost.writingForeground'));
  }
  const below = core.listGhosts(root).filter((g) => !rel || g.startsWith(rel + '/'));
  if (!below.length) return undefined;
  const n = below.length;
  const names = below.slice(0, 5).map((g) => `  ${g.slice(rel ? rel.length + 1 : 0)}`);
  return new vscode.FileDecoration(
    n > 9 ? '9+' : String(n),
    [`👻 ${n} unfinished file(s) in here:`, ...names, ...(n > 5 ? [`  …and ${n - 5} more`] : [])].join('\n'),
    new vscode.ThemeColor('vibeGhost.pendingForeground')
  );
}

const fileDecoChanged = new vscode.EventEmitter();
const fileBadges = {
  onDidChangeFileDecorations: fileDecoChanged.event,
  provideFileDecoration(uri) {
    if (uri.scheme !== 'file') return;
    const folder = folderBadge(uri.fsPath);
    if (folder !== null) return folder;
    const root = rootFor(uri);
    const rel = root && core.relOf(root, uri.fsPath);
    if (!rel) return;
    const act = core.readActive(root);
    if (act && act.files[rel]) {
      return new vscode.FileDecoration('✍', '👻 Claude is writing this file right now', new vscode.ThemeColor('vibeGhost.writingForeground'));
    }
    const groot = core.ghostRootFor(uri.fsPath);
    const g = groot && readGhost(core.ghostFile(groot, core.relOf(groot, uri.fsPath)));
    if (!g) return;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    let text = '';
    try {
      text = open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8');
    } catch {}
    const p = core.progress(core.splitLines(text), g.lines);
    if (p.done) return;
    const d = new vscode.FileDecoration(
      '👻',
      `👻 Not finished: ${p.pending} of ${p.total} draft lines left to type`,
      new vscode.ThemeColor('vibeGhost.pendingForeground')
    );
    d.propagate = true; // tint the parent folders so you can find it in the tree
    return d;
  },
};

// ---- Ghost Code view: only the files with a draft (or that Claude is writing), in their folders ----

const openDoc = (fsPath) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, fsPath));

// Progress of one draft, cached until the draft, the file on disk or its open buffer changes.
const progressCache = new Map(); // file path -> { key, p }
function draftProgress(root, rel, fsPath) {
  const g = readGhost(core.ghostFile(root, rel));
  if (!g) return null;
  const doc = openDoc(fsPath);
  let key = `${g.mtimeMs}:`;
  if (doc) key += `v${doc.version}`;
  else {
    try {
      key += `m${fs.statSync(fsPath).mtimeMs}`;
    } catch {
      key += 'gone';
    }
  }
  const hit = progressCache.get(fsPath);
  if (hit && hit.key === key) return hit.p;
  let text = '';
  try {
    text = doc ? doc.getText() : fs.readFileSync(fsPath, 'utf8');
  } catch {}
  const p = core.progress(core.splitLines(text), g.lines);
  progressCache.set(fsPath, { key, p });
  return p;
}

// Every file to show: { fsPath, root, rel, writing, p }.
function changedFiles() {
  const out = new Map();
  for (const root of roots()) {
    const act = core.readActive(root);
    const writing = new Set(act ? Object.keys(act.files) : []);
    for (const rel of new Set([...core.listGhosts(root), ...writing])) {
      const fsPath = path.join(root, ...rel.split('/'));
      if (out.has(fsPath)) continue;
      if (writing.has(rel)) {
        out.set(fsPath, { fsPath, root, rel, writing: true, p: null });
        continue;
      }
      const p = draftProgress(root, rel, fsPath);
      if (p && !p.done) out.set(fsPath, { fsPath, root, rel, writing: false, p });
    }
  }
  return [...out.values()];
}

// The folder tree above those files, from each workspace folder down (sub-repos are just folders
// in it, like in the Explorer). Several workspace folders: one top node each.
function buildTree(files) {
  const folders = vscode.workspace.workspaceFolders || [];
  const top = { kind: 'folder', children: new Map() };
  const multi = folders.length > 1;
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  for (const f of files) {
    const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f.fsPath));
    const base = wf ? wf.uri.fsPath : f.root;
    let node = top;
    if (multi || !wf) {
      const name = wf ? wf.name : path.basename(f.root);
      if (!node.children.has(key(base))) node.children.set(key(base), { kind: 'folder', name, fsPath: base, children: new Map(), isRoot: true });
      node = node.children.get(key(base));
    }
    const parts = path.relative(base, f.fsPath).split(path.sep);
    let dir = base;
    for (const part of parts.slice(0, -1)) {
      dir = path.join(dir, part);
      if (!node.children.has(key(dir))) node.children.set(key(dir), { kind: 'folder', name: part, fsPath: dir, children: new Map() });
      node = node.children.get(key(dir));
    }
    node.children.set(key(f.fsPath), { kind: 'file', ...f });
  }
  const compact = vscode.workspace.getConfiguration('explorer').get('compactFolders', true);
  const finish = (node) => {
    let kids = [...node.children.values()];
    if (compact) {
      kids = kids.map((k) => {
        // a/b/c in one row while each folder holds just one folder, like the Explorer
        while (k.kind === 'folder' && !k.isRoot && k.children.size === 1) {
          const only = [...k.children.values()][0];
          if (only.kind !== 'folder') break;
          k = { ...only, name: `${k.name}/${only.name}` };
        }
        return k;
      });
    }
    kids.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base', numeric: true })));
    for (const k of kids) if (k.kind === 'folder') k.list = finish(k);
    return kids;
  };
  return finish(top);
}

const nameOf = (n) => n.name || path.basename(n.fsPath);

const treeChanged = new vscode.EventEmitter();
const ghostTree = {
  onDidChangeTreeData: treeChanged.event,
  getChildren(node) {
    return node ? node.list : buildTree(changedFiles());
  },
  getTreeItem(node) {
    const uri = vscode.Uri.file(node.fsPath);
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `d:${node.fsPath}`;
      item.resourceUri = uri; // folder icon from the icon theme + the count badge
      item.iconPath = vscode.ThemeIcon.Folder;
      item.tooltip = node.fsPath;
      item.contextValue = 'ghostFolder';
      return item;
    }
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.id = `f:${node.fsPath}`;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
    if (node.writing) {
      item.description = 'Claude writing…';
      item.tooltip = `✍ ${node.rel}: Claude is writing it right now. Don't type until it finishes.`;
      item.contextValue = 'ghostWriting';
    } else {
      item.description = `${node.p.pending} left`;
      item.tooltip = `👻 ${node.rel}: ${node.p.pending} of ${node.p.total} draft lines left to type`;
      item.contextValue = 'ghostFile';
    }
    return item;
  },
};

let ghostView;
let treeTimer;
let treeDirty = false;
// Count on the tab icon right away; the tree itself only rebuilds while you can see it.
function refreshTree() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(() => {
    if (!ghostView) return;
    const n = roots().reduce((acc, r) => acc + core.listGhosts(r).length, 0);
    ghostView.badge = n ? { value: n, tooltip: `👻 ${n} file(s) to type` } : undefined;
    if (ghostView.visible) treeChanged.fire();
    else treeDirty = true;
  }, 250);
}

// From a tree row, a Uri, or else the active editor.
function targetUri(arg) {
  if (arg instanceof vscode.Uri) return arg;
  if (arg && typeof arg.fsPath === 'string') return vscode.Uri.file(arg.fsPath);
  const editor = vscode.window.activeTextEditor;
  return editor && editor.document.uri;
}

// ---- focus mode: in a draft file the ghost is the only autocomplete ----
// IntelliSense popups and AI inline suggestions fight the ghost for the cursor (and for Enter/Tab).
// While a draft file is active they're switched off in user settings; leaving restores the exact
// previous values. The backup lives in globalState, so a crash gets restored on next start.

const FOCUS = 'vibeGhost.focusBackup';

function quietSettings() {
  const cfg = vscode.workspace.getConfiguration();
  const quiet = {
    'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' },
    'editor.suggestOnTriggerCharacters': false,
    'editor.wordBasedSuggestions': 'off',
    'github.copilot.nextEditSuggestions.enabled': false,
  };
  const cop = cfg.inspect('github.copilot.enable');
  if (cop && cop.defaultValue !== undefined) {
    const langs = Object.keys({ ...(cop.defaultValue || {}), ...(cop.globalValue || {}) });
    quiet['github.copilot.enable'] = Object.fromEntries([...new Set(['*', ...langs])].map((k) => [k, false]));
  }
  // only settings that exist here (Copilot may not be installed)
  return Object.entries(quiet).filter(([k]) => {
    const i = cfg.inspect(k);
    return i && i.defaultValue !== undefined;
  });
}

const focusWanted = () => {
  const editor = vscode.window.activeTextEditor;
  const g = editor && ghostFor(editor.document);
  return vscode.workspace.getConfiguration('vibeGhost').get('quietOtherCompletions', true) && !!g && !core.isActive(g.root);
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function enterFocus() {
  if (ctx.globalState.get(FOCUS)) return;
  const cfg = vscode.workspace.getConfiguration();
  const pairs = quietSettings();
  // saved = { key: [original, ours] }. null original = "was not set", so restoring removes our
  // value instead of pinning a default. A value that already equals ours is a leftover of ours.
  const saved = Object.fromEntries(
    pairs.map(([k, v]) => {
      const cur = cfg.inspect(k).globalValue;
      return [k, [cur === undefined || same(cur, v) ? null : cur, v]];
    })
  );
  await ctx.globalState.update(FOCUS, saved);
  for (const [k, v] of pairs) {
    try {
      await cfg.update(k, v, vscode.ConfigurationTarget.Global);
    } catch {}
  }
}

async function leaveFocus() {
  const saved = ctx && ctx.globalState.get(FOCUS);
  if (!saved) return;
  const cfg = vscode.workspace.getConfiguration();
  for (const [k, [orig, ours]] of Object.entries(saved)) {
    // changed by you while in the draft file? then your change wins
    if (!same(cfg.inspect(k).globalValue, ours)) continue;
    try {
      await cfg.update(k, orig === null ? undefined : orig, vscode.ConfigurationTarget.Global);
    } catch {}
  }
  await ctx.globalState.update(FOCUS, undefined);
}

// Serialized so fast tab switching can't interleave a save and a restore.
let focusChain = Promise.resolve();
let focusTimer;
function runFocus() {
  clearTimeout(focusTimer);
  focusChain = focusChain.then(() => (focusWanted() ? enterFocus() : leaveFocus())).then(refreshStatus, () => {});
  return focusChain;
}
function updateFocus() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(runFocus, 300);
}

// VS Code only asks for decorations of rows it renders, and folder tint only bubbles up from
// decorations it already has. So name every draft file (and repo folder) explicitly, like the
// git extension does: then a collapsed sub-repo folder still lights up. Previously announced
// paths are included so finished files lose their badge.
let announced = new Set();
function announceDecorations() {
  const now = new Set();
  for (const r of roots()) {
    now.add(r);
    for (const rel of core.listGhosts(r)) {
      const parts = rel.split('/');
      for (let i = 1; i <= parts.length; i++) now.add(path.join(r, ...parts.slice(0, i))); // file + every folder above it
    }
    const act = core.readActive(r);
    if (act) for (const rel of Object.keys(act.files)) now.add(path.join(r, ...rel.split('/')));
  }
  const all = [...new Set([...announced, ...now])].map((p) => vscode.Uri.file(p));
  announced = now;
  fileDecoChanged.fire(all);
  return all;
}

const stats = { rejected: 0 };
// The draft at the cursor is real (multi-line) ghost text from the inline provider. VS Code only
// asks inline providers by itself while you type, so whenever the cursor comes to rest where typing
// continues (file opened, a click, Ctrl+Alt+G, a fresh draft) we ask for ours: the code to type is on
// screen before you type a thing. Only ours: since VS Code 1.106 the trigger takes a providerId, so
// Copilot and friends (kept quiet by focus mode) are not woken. Older VS Code: the ghost at the cursor
// shows once you start typing; until then the cursor line gets the decorations.
let inlineShowing = false;
let lastEdit = 0;
const typedJustNow = () => Date.now() - lastEdit < 150;
function onSelection(e) {
  if (!typedJustNow()) inlineShowing = false; // moved, not typed: VS Code hid it
  scheduleRender();
}

function onActiveEditor() {
  inlineShowing = false; // another file: VS Code dropped whatever it showed
  scheduleRender();
}

function atLeast(version, min) {
  const a = version.split(/[.-]/).map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
}
const canShowOurs = atLeast(vscode.version, '1.106.0');

let shownAt = null; // where we last asked for the ghost: document, version, draft, cursor
function showGhostHere() {
  const editor = vscode.window.activeTextEditor;
  if (!canShowOurs || !editor || typedJustNow()) return; // typing: VS Code asks by itself
  if (editor.selections.length !== 1 || !editor.selection.isEmpty) return;
  const doc = editor.document;
  const g = ghostFor(doc);
  if (!g || core.isActive(g.root) || isStale(doc)) return;
  if (!cursorGhost(editor, core.splitLines(doc.getText()), g)) return;
  const pos = editor.selection.active;
  const at = `${doc.uri}|${doc.version}|${g.mtimeMs}|${pos.line}:${pos.character}`;
  if (inlineShowing && shownAt === at) return; // up already, or you dismissed it with Esc
  shownAt = at;
  inlineShowing = true;
  vscode.commands
    .executeCommand('editor.action.inlineSuggest.trigger', { providerId: `${ctx.extension.id}:*`, explicit: false })
    .then(undefined, (err) => log.info(`showing the ghost failed: ${err && err.message}`));
}

// Cursor stop per ghost part, on its first line: where typing continues (its ghost shows there),
// else the end of that line.
function ghostStops(doc) {
  const { g, user, ops, parts } = partsOf(doc);
  if (!g) return [];
  const lines = [...new Set(parts.map((p) => p.start))].sort((a, b) => a - b);
  return lines.map((l) => new vscode.Position(l, core.ghostCol(user, g.lines, l, ops) ?? user[l].length));
}

function goTo(editor, pos) {
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// Opening a draft file puts the cursor where typing starts, so the ghost shows right away. Once per
// opened file, and only from the very top (anywhere else is where you left off).
const jumped = new Set();
function jumpToFirstGhost() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !vscode.workspace.getConfiguration('vibeGhost').get('jumpToGhost', true)) return;
  const key = editor.document.uri.toString();
  if (jumped.has(key)) return;
  const [first] = ghostStops(editor.document);
  if (!first) return;
  jumped.add(key);
  const pos = editor.selection.active;
  if (pos.line || pos.character || first.isEqual(pos)) return;
  goTo(editor, first);
}

function updateContext() {
  const editor = vscode.window.activeTextEditor;
  vscode.commands.executeCommand('setContext', 'vibeGhost.draftOpen', !!(editor && ghostFor(editor.document)));
}

// Fully typed: the draft has served its purpose.
function finish(g) {
  if (doneShown.has(g.gp)) return;
  doneShown.add(g.gp);
  fs.rmSync(g.gp, { force: true });
  cache.delete(g.gp);
  vscode.window.showInformationMessage(`✅ ${g.rel} fully typed by you. Commit away.`);
  refreshStatus();
}

let timer;
function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    jumpToFirstGhost();
    showGhostHere(); // before rendering: the cursor line then leaves the ghost to the inline provider
    for (const e of vscode.window.visibleTextEditors) render(e);
    refreshStatus();
    updateContext();
    lensChanged.fire();
    announceDecorations();
    updateFocus();
    refreshTree();
  }, 60);
}

// ---- on by default ----

// Git repos get ghost mode automatically: the opened folder if it is one, else its sub-repos
// (plus hooks at the top, for a `claude` started there). Already-enabled folders get their hook
// path refreshed, so updating the extension never leaves Claude calling a ghost.js that's gone.
async function autoEnable(root) {
  try {
    const repos = setup.reposIn(root);
    if (!repos.length) return;
    const was = [root, ...repos].some(setup.isInstalled);
    if (!was) {
      if (!vscode.workspace.getConfiguration('vibeGhost').get('autoEnable', true)) return;
      if (ctx.globalState.get(DISABLED, []).includes(root)) return;
    }
    setup.enableTree(root, bin);
    rootsCache = null;
    if (was) return;
    refreshStatus();
    const pick = await vscode.window.showInformationMessage(
      `👻 Ghost mode is on for ${repos.map((r) => path.basename(r)).join(', ')}: Claude Code edits become ghost code you type yourself. Already-running claude sessions need a restart.`,
      'Disable here'
    );
    if (pick) await setEnabled(root, false);
  } catch (e) {
    core.logError(root, e);
  }
}

// `root` is an opened folder: it and its sub-repos are switched together.
async function setEnabled(root, on) {
  const off = ctx.globalState.get(DISABLED, []).filter((r) => r !== root);
  await ctx.globalState.update(DISABLED, on ? off : [...off, root]);
  const repos = on ? setup.enableTree(root, bin).repos : setup.disableTree(root);
  const names = repos.map((r) => path.basename(r)).join(', ') || path.basename(root);
  vscode.window.showInformationMessage(
    on ? `👻 Ghost mode enabled for ${names}.` : `Ghost mode removed from ${names}. Pending drafts stay in .ghost/.`
  );
  rootsCache = null;
  refreshStatus();
}

// ---- asking Claude about a ghost part ----

// Ghost parts of a document that's ready to show ghosts, else [].
function partsOf(doc) {
  const g = ghostFor(doc);
  if (!g || core.isActive(g.root) || isStale(doc)) return { g: null, user: [], ops: [], parts: [] };
  const user = core.splitLines(doc.getText());
  const ops = core.align(user, g.lines);
  return { g, user, ops, parts: core.hunks(user, g.lines, ops) };
}

const threadLine = (part) => Math.max(part.lens - 1, 0);

const codeLenses = {
  onDidChangeCodeLenses: lensChanged.event,
  provideCodeLenses(doc) {
    if (!vscode.workspace.getConfiguration('vibeGhost').get('askLens', true)) return [];
    return partsOf(doc).parts.map((p) => {
      const range = new vscode.Range(p.lens, 0, p.lens, 0);
      return new vscode.CodeLens(range, {
        title: '💬 Ask Claude about this',
        command: 'vibeGhost.openAsk',
        arguments: [doc.uri, threadLine(p)],
      });
    });
  },
};

// What the question is about: the ghost part at `line` (computed once, at the first question).
function partContext(doc, line) {
  const { g, user, parts } = partsOf(doc);
  const part = g && core.hunkAt(parts, line);
  const lang = doc.languageId;
  const head = `I'm typing out code you drafted by hand (ghost mode). The file is \`${g ? g.rel : vscode.workspace.asRelativePath(doc.uri)}\`.`;
  if (!part) return `${head}\n\nMy question is about line ${line + 1}.`;
  const mine = user.slice(part.start, part.end + 1);
  const draft =
    part.gFrom === null
      ? 'Your draft deletes these lines of mine:'
      : `Your draft, lines ${part.gFrom + 1}-${part.gTo}:\n\`\`\`${lang}\n${g.lines.slice(part.gFrom, part.gTo).join('\n')}\n\`\`\`\nWhat I've typed there so far:`;
  return [
    head,
    `The full draft is at \`.ghost/files/${g.rel}\`; my file on disk is my own typed version.`,
    '',
    draft,
    `\`\`\`${lang}\n${mine.join('\n')}\n\`\`\``,
    '',
    'Answer my question about this part. Be concise, explain the why. Do not edit files.',
  ].join('\n');
}

function buildPrompt(st, question) {
  const earlier = st.history.flatMap(({ q, a }) => [`Q: ${q}`, `A: ${a}`, '']);
  return [st.context, '', ...(earlier.length ? ['Earlier in this thread:', ...earlier] : []), `Question: ${question}`].join('\n');
}

// Newest Claude Code session for this folder = the one you've been running in the terminal.
// Questions never persist (--no-session-persistence), so they can't shadow it.
function terminalSession(root) {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const dir = path.join(base, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return newest && { id: path.basename(newest.f, '.jsonl'), t: newest.t, dir: root };
  } catch {
    return null;
  }
}

function runClaude(root, prompt, args) {
  const cfg = vscode.workspace.getConfiguration('vibeGhost');
  const model = cfg.get('askModel', '');
  const all = ['-p', '--output-format', 'json', '--no-session-persistence', ...args, ...(model ? ['--model', model] : [])];
  all.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
  return new Promise((resolve, reject) => {
    // shell: true so claude.cmd shims work on Windows; the prompt goes via stdin, never argv.
    const child = spawn(cfg.get('claudePath', 'claude'), all, {
      cwd: root,
      shell: true,
      env: { ...process.env, VIBE_GHOST_SKIP: '1' },
    });
    let out = '';
    let err = '';
    const kill = setTimeout(() => child.kill(), 5 * 60 * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(kill);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
      let res;
      try {
        res = line && JSON.parse(line);
      } catch {}
      if (res && !res.is_error && typeof res.result === 'string') return resolve(res.result);
      reject(new Error((res && res.result) || err.trim() || out.trim() || `claude exited with ${code}`));
    });
    child.stdin.end(prompt);
  });
}

// `dirs`: the file's repo first, then the opened folder (claude may have been started in either).
async function askClaude(dirs, prompt) {
  const useCtx = vscode.workspace.getConfiguration('vibeGhost').get('askWithSessionContext', true);
  const s = useCtx && dirs.map(terminalSession).filter(Boolean).sort((a, b) => b.t - a.t)[0];
  if (s) {
    // Fork the terminal session: Claude remembers why it wrote the draft, the original stays untouched.
    // --resume only finds a session from the folder it was started in, so run there.
    try {
      return await runClaude(s.dir, prompt, ['--resume', s.id, '--fork-session']);
    } catch {}
  }
  return runClaude(dirs[0], prompt, []);
}

const comment = (body, name) => ({
  body: typeof body === 'string' ? new vscode.MarkdownString(body, true) : body,
  mode: vscode.CommentMode.Preview,
  author: { name },
});

function makeThread(uri, line) {
  const t = comments.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
  t.label = '👻 Ask Claude';
  t.canReply = true;
  t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  return t;
}

function refreshStatus() {
  const rs = roots();
  if (rs.some(core.isActive)) {
    statusItem.text = '$(loading~spin) 👻 Claude writing…';
    statusItem.tooltip = 'Claude\'s drafts are on disk during its turn. Don\'t type until it finishes.';
    return statusItem.show();
  }
  const n = rs.reduce((acc, r) => acc + core.listGhosts(r).length, 0);
  const off = rs.length && rs.every(core.isOff);
  const marked = rs.some(core.readMark);
  if (!n && !off && !marked) return statusItem.hide();
  const focus = ctx && ctx.globalState.get(FOCUS);
  statusItem.text = (off ? '👻 off' : `👻 ${n} to type`) + (marked ? ' · marked' : '') + (focus ? ' · autocomplete off' : '');
  statusItem.tooltip =
    (off ? 'Ghost mode off: Claude edits files directly.' : 'Claude drafts waiting for you to type them') +
    (marked ? '\nBaseline marked: run "Ghost: Ghostify changes" after your AI tool is done.' : '') +
    (focus ? '\nOther autocomplete is paused in this draft file (Ctrl+Space still works). It comes back when you leave it.' : '');
  statusItem.show();
}

// Paste guard: a big chunk that comes straight out of the draft gets undone.
let ownEdit = false; // our own Tab-completed comment line
function onChange(e) {
  if (layoutEdit) return scheduleRender(); // our empty lines: not typing, not a paste
  if (e.contentChanges.length) expandRounds.delete(e.document.uri.toString());
  const active = vscode.window.activeTextEditor;
  if (active && active.document === e.document) {
    lastEdit = Date.now();
    inlineShowing = true;
    if (e.contentChanges.length) typedAt.set(e.document.uri.toString(), e.document.version);
  }
  scheduleRender();
  const cfg = vscode.workspace.getConfiguration('vibeGhost');
  if (ownEdit || !cfg.get('blockPaste', true) || e.reason !== undefined || !e.document.isDirty) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== e.document) return;
  const g = ghostFor(e.document);
  if (!g || core.isActive(g.root)) return;
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  const min = cfg.get('pasteThreshold', 40);
  const draft = squash(g.text);
  const cheat = e.contentChanges.some((c) => {
    const t = squash(c.text);
    return t.length >= min && draft.includes(t);
  });
  if (cheat) {
    vscode.commands.executeCommand('undo');
    vscode.window.showWarningMessage('👻 Nope. Type it, don\'t paste it.');
  }
}

async function pickFrom(list, placeHolder) {
  if (list.length <= 1) return list[0];
  const pick = await vscode.window.showQuickPick(
    list.map((r) => ({ label: path.basename(r), description: r, r })),
    { placeHolder }
  );
  return pick && pick.r;
}

// The repo of the file you're in, else ask (sub-repos of the opened folder included).
async function pickRoot() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const r = rootFor(editor.document.uri);
    if (r && roots().includes(r)) return r;
  }
  return pickFrom(roots(), 'Which repo?');
}

// An opened (workspace) folder, for switching ghost mode on/off for it and its sub-repos.
const pickFolder = () => pickFrom((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath), 'Which folder?');

const commands = {
  // From the palette (active editor) or a row of the Ghost Code view.
  async showDraft(arg) {
    const uri = targetUri(arg);
    const g = uri && ghostForUri(uri);
    if (!g) return vscode.window.showInformationMessage('No Claude draft for this file.');
    const left = vscode.Uri.from({ scheme: SCHEME, path: '/' + g.rel, query: g.gp });
    await vscode.commands.executeCommand('vscode.diff', left, uri, `${path.basename(g.rel)}: Claude draft ↔ yours`);
  },

  async discard(arg) {
    const uri = targetUri(arg);
    const g = uri && ghostForUri(uri);
    if (!g) return;
    const ok = await vscode.window.showWarningMessage(`Throw away Claude's draft of ${g.rel}?`, { modal: true }, 'Discard');
    if (ok !== 'Discard') return;
    fs.rmSync(g.gp, { force: true });
    cache.delete(g.gp);
    // The empty lines still waiting for the draft's lines go with it.
    const doc = openDoc(uri.fsPath);
    if (doc && expandOn()) {
      const user = core.splitLines(doc.getText());
      const waiting = core
        .align(user, g.lines)
        .filter((op) => op.t === 'pair' && user[op.u] === '' && g.lines[op.g].trim())
        .map((op) => op.u);
      if (waiting.length) {
        const edit = new vscode.WorkspaceEdit();
        for (const r of lineDeletes(doc, waiting)) edit.delete(doc.uri, r);
        await vscode.workspace.applyEdit(edit);
      }
    }
    scheduleRender();
  },

  async list() {
    const items = [];
    for (const root of roots()) {
      for (const rel of core.listGhosts(root)) {
        const p = core.fileProgress(root, rel);
        const file = path.join(root, ...rel.split('/'));
        items.push({ label: vscode.workspace.asRelativePath(file), description: `${p.total - p.pending}/${p.total} lines typed`, file });
      }
    }
    if (!items.length) return vscode.window.showInformationMessage('No drafts pending. 👻');
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Claude drafts waiting to be typed' });
    if (pick) vscode.window.showTextDocument(vscode.Uri.file(pick.file));
  },

  async toggle() {
    const root = await pickRoot();
    if (!root) return;
    const off = !core.isOff(root);
    core.setOff(root, off);
    vscode.window.showInformationMessage(off ? 'Ghost mode OFF: Claude edits files directly.' : 'Ghost mode ON: Claude writes drafts, you type them.');
    refreshStatus();
  },

  async recover() {
    const active = roots().filter(core.isActive);
    if (!active.length) return vscode.window.showInformationMessage('Nothing to recover.');
    const ok = await vscode.window.showWarningMessage(
      'Put your own files back and turn what Claude left on disk into drafts? Only do this if Claude is NOT running a turn right now.',
      { modal: true },
      'Recover'
    );
    if (ok !== 'Recover') return;
    for (const r of active) core.swapOut(r);
    cache.clear();
    scheduleRender();
  },

  // From the CodeLens (uri, line), or the palette (cursor position).
  openAsk(uri, line) {
    const editor = vscode.window.activeTextEditor;
    if (!uri) {
      if (!editor) return;
      uri = editor.document.uri;
      const part = core.hunkAt(partsOf(editor.document).parts, editor.selection.active.line);
      line = part ? threadLine(part) : editor.selection.active.line;
    }
    makeThread(uri, line);
  },

  // Submit button of the question box.
  async ask(reply) {
    const { thread, text } = reply;
    const question = text.trim();
    const st = threads.get(thread) || { history: [] };
    if (!question || st.busy) return;
    threads.set(thread, st);

    const doc = await vscode.workspace.openTextDocument(thread.uri);
    const dirs = [...new Set([rootFor(doc.uri), wsFolder(doc.uri)].filter(Boolean))];
    if (!dirs.length) return;
    st.context = st.context || partContext(doc, thread.range.start.line);

    st.busy = true;
    const before = [...thread.comments, comment(question, 'You')];
    thread.comments = [...before, comment('$(loading~spin) thinking…', 'Claude')];
    try {
      const answer = await askClaude(dirs, buildPrompt(st, question));
      st.history.push({ q: question, a: answer });
      thread.comments = [...before, comment(answer, 'Claude')];
    } catch (e) {
      thread.comments = [...before, comment(`⚠️ ${e.message}`, 'Claude')];
    } finally {
      st.busy = false;
    }
  },

  async enableHere() {
    const root = await pickFolder();
    if (root) await setEnabled(root, true);
  },

  async disableHere() {
    const root = await pickFolder();
    if (root) await setEnabled(root, false);
  },

  async mark() {
    const root = await pickRoot();
    if (!root) return;
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    try {
      core.mark(root);
      vscode.window.showInformationMessage('👻 Baseline marked. Let your AI tool work, then run "Ghost: Ghostify changes".');
    } catch (e) {
      vscode.window.showErrorMessage(`Mark failed (is this a git repo?): ${e.message}`);
    }
    refreshStatus();
  },

  async ghostify() {
    const root = await pickRoot();
    if (!root) return;
    const since = core.readMark(root) ? 'your mark' : 'the last commit (no mark set: your own uncommitted edits count too)';
    const ok = await vscode.window.showWarningMessage(
      `Turn every change since ${since} into ghost code and put the files back for you to type?`,
      { modal: true },
      'Ghostify'
    );
    if (ok !== 'Ghostify') return;
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    try {
      const { drafted, skipped } = core.ghostify(root);
      cache.clear();
      const extra = skipped.length ? ` (${skipped.length} binary file(s) left as is)` : '';
      vscode.window.showInformationMessage(drafted.length ? `👻 ${drafted.length} draft(s) to type${extra}.` : `Nothing to ghostify${extra}.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Ghostify failed: ${e.message}`);
    }
    scheduleRender();
  },

  // Tab while the draft's ghost text is visible: if the line due here is entirely a comment
  // (/** */ block, //, #), fill in that one line; code is never accepted, Tab just indents.
  async noAccept() {
    const editor = vscode.window.activeTextEditor;
    const doc = editor && editor.document;
    const g = doc && ghostFor(doc);
    const pos = editor && editor.selection.active;
    if (g && vscode.workspace.getConfiguration('vibeGhost').get('tabCompletesComments', true)) {
      const f = core.tabFill(core.splitLines(doc.getText()), g.lines, pos.line, pos.character, doc.languageId);
      if (f) {
        ownEdit = true; // not a paste: keep the paste guard out of it
        try {
          await editor.edit((b) => b.replace(new vscode.Range(f.line, f.from, f.line, f.to), f.text));
        } finally {
          ownEdit = false;
        }
        // cursor to the end of what was filled, so the next Tab continues from there
        const parts = f.text.split('\n');
        const end = new vscode.Position(f.line + parts.length - 1, parts.length > 1 ? parts[parts.length - 1].length : f.from + f.text.length);
        editor.selection = new vscode.Selection(end, end);
        log.info(`Tab ${g.rel}:${pos.line + 1}:${pos.character + 1} [${doc.languageId}] filled comment line`);
        return;
      }
      log.info(`Tab ${g.rel}:${pos.line + 1}:${pos.character + 1} [${doc.languageId}] nothing to fill here (no whole-line comment due at the cursor), indent`);
    } else if (doc) {
      log.info(`Tab ${vscode.workspace.asRelativePath(doc.uri)}: ${g ? 'tabCompletesComments is off' : 'no draft for this file'}, indent`);
    }
    return vscode.commands.executeCommand('tab');
  },

  async rejectAccept() {
    stats.rejected++;
    await vscode.commands.executeCommand('undo');
    vscode.window.showWarningMessage('👻 Nope. Type it, don\'t accept it.');
  },

  closeThread(thread) {
    if (thread) thread.dispose();
  },

  // The ghost of the part it lands on shows right away (showGhostHere).
  nextGhost() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const stops = ghostStops(editor.document);
    if (!stops.length) return;
    const cur = editor.selection.active.line;
    goTo(editor, stops.find((p) => p.line > cur) ?? stops[0]);
  },
};

function activate(context) {
  deco = makeDecorations();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'vibeGhost.list';

  comments = vscode.comments.createCommentController('vibeGhost', 'Ask Claude');
  comments.options = { prompt: 'Ask Claude about this ghost code…', placeHolder: 'Why this approach? What does this line do?' };
  comments.commentingRangeProvider = {
    provideCommentingRanges: (doc) =>
      partsOf(doc).parts.map((p) => new vscode.Range(threadLine(p), 0, Math.max(p.end, p.lens), 0)),
  };
  ghostView = vscode.window.createTreeView('vibeGhost.files', { treeDataProvider: ghostTree, showCollapseAll: true });

  context.subscriptions.push(
    statusItem,
    comments,
    lensChanged,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLenses),
    ...Object.values(deco),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => {
        try {
          return fs.readFileSync(uri.query, 'utf8');
        } catch {
          return '(draft is gone: fully typed or discarded)';
        }
      },
    }),
    vscode.workspace.onDidChangeTextDocument(onChange),
    vscode.window.onDidChangeVisibleTextEditors(scheduleRender),
    vscode.window.onDidChangeActiveTextEditor(onActiveEditor),
    vscode.window.onDidChangeTextEditorSelection(onSelection),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const id = doc.uri.toString();
      jumped.delete(id);
      savedAt.delete(id);
      typedAt.delete(id);
      expandRounds.delete(id);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const g = ghostFor(doc);
      if (g) savedAt.set(doc.uri.toString(), `${doc.version}|${g.mtimeMs}`);
    }),
    vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, inlineGhost),
    vscode.window.registerFileDecorationProvider(fileBadges),
    fileDecoChanged,
    ghostView,
    ghostView.onDidChangeVisibility((e) => {
      if (e.visible && treeDirty) {
        treeDirty = false;
        treeChanged.fire();
      }
    }),
    treeChanged,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('explorer.compactFolders') && refreshTree()),
    ...Object.entries(commands).map(([name, fn]) => vscode.commands.registerCommand(`vibeGhost.${name}`, fn))
  );

  ctx = context;
  bin = path.join(context.extensionPath, 'bin', 'ghost.js');
  log = vscode.window.createOutputChannel('Vibecodus Maximus', { log: true });
  context.subscriptions.push(log);
  log.info(`activated ${context.extension.packageJSON.version}`);
  const addFolder = (folder) => {
    // **/ so sub-repos' .ghost folders are watched too
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `**/${core.DIR}/**`));
    const changed = (uri) => {
      cache.delete(uri.fsPath);
      doneShown.delete(uri.fsPath);
      scheduleRender();
    };
    w.onDidCreate((uri) => {
      rootsCache = null; // a repo may have just got its first .ghost
      changed(uri);
    });
    w.onDidChange(changed);
    w.onDidDelete(changed);
    context.subscriptions.push(w);
    autoEnable(folder.uri.fsPath);
  };
  (vscode.workspace.workspaceFolders || []).forEach(addFolder);

  // Drafts of docs/styles left from before (or after a config change): apply, don't make anyone type them.
  const applied = roots().flatMap((r) => core.applyDirect(r).map((rel) => path.basename(rel)));
  if (applied.length) {
    vscode.window.showInformationMessage(`👻 Applied ${applied.length} doc/style draft(s) directly, no typing needed: ${applied.join(', ')}`);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      rootsCache = null;
      e.added.forEach(addFolder);
    })
  );

  scheduleRender();
  return { inlineGhost, fileBadges, ghostTree, announceDecorations, stats, settleFocus: runFocus }; // for the VS Code integration test
}

// Window closing: give the user their autocomplete back.
function deactivate() {
  return leaveFocus();
}

module.exports = { activate, deactivate };
