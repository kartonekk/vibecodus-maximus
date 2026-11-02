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

// Draft info for a document, or null if it has none.
function ghostFor(doc) {
  if (doc.uri.scheme !== 'file') return null;
  const root = core.ghostRootFor(doc.uri.fsPath);
  if (!root) return null;
  const rel = core.relOf(root, doc.uri.fsPath);
  if (!rel) return null;
  const gp = core.ghostFile(root, rel);
  const g = readGhost(gp);
  return g && { root, rel, gp, ...g };
}

// Right after a Claude turn the buffer may still show Claude's code until VS Code reloads
// the restored file. Rendering then would mark the draft as "fully typed" and delete it.
function isStale(doc) {
  if (doc.isDirty) return false;
  try {
    return fs.readFileSync(doc.uri.fsPath, 'utf8').replace(/^﻿/, '') !== doc.getText();
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
  const out = { suffix: [], insert: [], mismatch: [], extra: [] };
  const lang = doc.languageId;
  // The cursor line gets real (multi-line) ghost text from the inline provider instead.
  const skipLine = inlineShowing && cursorGhost(editor, user, g, ops) ? editor.selection.active.line : -1;

  for (const op of ops) {
    if ((op.t === 'pair' && op.u === skipLine) || (op.t === 'ins' && op.at === skipLine)) continue;
    if (op.t === 'pair') {
      const u = user[op.u];
      const want = g.lines[op.g];
      const d = core.lineDiff(u, want);
      if (d.kind === 'suffix') {
        const end = new vscode.Position(op.u, d.at); // the gap before an auto-closed quote/bracket, or the end
        out.suffix.push({
          range: new vscode.Range(end, end),
          renderOptions: { after: { contentText: show(d.text, tabSize) } },
        });
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
// The inline ghost shows when VS Code triggers inline suggestions itself, i.e. while you type.
// We never trigger them by command: a manual trigger also wakes Copilot and friends, which focus
// mode keeps quiet. So: typing = inline ghost; just moving the cursor = decorations on that line.
let inlineShowing = false;
let lastEdit = 0;
function onSelection(e) {
  if (Date.now() - lastEdit > 150) inlineShowing = false; // moved, not typed: VS Code hid it
  scheduleRender();
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
    for (const e of vscode.window.visibleTextEditors) render(e);
    refreshStatus();
    updateContext();
    lensChanged.fire();
    announceDecorations();
    updateFocus();
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
  if (!g || core.isActive(g.root) || isStale(doc)) return { g: null, user: [], parts: [] };
  const user = core.splitLines(doc.getText());
  return { g, user, parts: core.hunks(user, g.lines) };
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
  const active = vscode.window.activeTextEditor;
  if (active && active.document === e.document) {
    lastEdit = Date.now();
    inlineShowing = true;
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
  async showDraft() {
    const editor = vscode.window.activeTextEditor;
    const g = editor && ghostFor(editor.document);
    if (!g) return vscode.window.showInformationMessage('No Claude draft for this file.');
    const left = vscode.Uri.from({ scheme: SCHEME, path: '/' + g.rel, query: g.gp });
    await vscode.commands.executeCommand('vscode.diff', left, editor.document.uri, `${path.basename(g.rel)}: Claude draft ↔ yours`);
  },

  async discard() {
    const editor = vscode.window.activeTextEditor;
    const g = editor && ghostFor(editor.document);
    if (!g) return;
    const ok = await vscode.window.showWarningMessage(`Throw away Claude's draft of ${g.rel}?`, { modal: true }, 'Discard');
    if (ok !== 'Discard') return;
    fs.rmSync(g.gp, { force: true });
    cache.delete(g.gp);
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

  nextGhost() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const lines = partsOf(editor.document).parts.map((p) => p.start);
    if (!lines.length) return;
    const cur = editor.selection.active.line;
    const line = lines.find((l) => l > cur) ?? lines[0];
    const pos = editor.document.lineAt(line).range.end;
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
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
    vscode.window.onDidChangeActiveTextEditor(scheduleRender),
    vscode.window.onDidChangeTextEditorSelection(onSelection),
    vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, inlineGhost),
    vscode.window.registerFileDecorationProvider(fileBadges),
    fileDecoChanged,
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
  return { inlineGhost, fileBadges, announceDecorations, stats, settleFocus: runFocus }; // for the VS Code integration test
}

// Window closing: give the user their autocomplete back.
function deactivate() {
  return leaveFocus();
}

module.exports = { activate, deactivate };
