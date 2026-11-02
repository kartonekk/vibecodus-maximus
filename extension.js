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

function rootFor(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder && folder.uri.fsPath;
}

function roots() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
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
  const root = rootFor(doc.uri);
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

function render(editor) {
  const doc = editor.document;
  const g = ghostFor(doc);
  if (!g || core.isActive(g.root) || isStale(doc)) return clear(editor);

  const tabSize = Number(editor.options.tabSize) || 4;
  const user = core.splitLines(doc.getText());
  const ops = core.align(user, g.lines);
  const out = { suffix: [], insert: [], mismatch: [], extra: [] };
  const lang = doc.languageId;

  for (const op of ops) {
    if (op.t === 'pair') {
      const u = user[op.u];
      const want = g.lines[op.g];
      const d = core.lineDiff(u, want);
      if (d.kind === 'suffix') {
        const end = new vscode.Position(op.u, u.length);
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
    lensChanged.fire();
  }, 60);
}

// ---- on by default ----

// Git repos get ghost mode automatically. Already-enabled folders get their hook path refreshed,
// so updating the extension (new install dir) never leaves Claude calling a ghost.js that's gone.
async function autoEnable(root) {
  try {
    const was = setup.isInstalled(root);
    if (!was) {
      if (!vscode.workspace.getConfiguration('vibeGhost').get('autoEnable', true)) return;
      if (ctx.globalState.get(DISABLED, []).includes(root) || !setup.isRepo(root)) return;
    }
    setup.install(root, bin);
    if (was) return;
    refreshStatus();
    const pick = await vscode.window.showInformationMessage(
      `👻 Ghost mode is on for ${path.basename(root)}: Claude Code edits become ghost code you type yourself. Already-running claude sessions need a restart.`,
      'Disable here'
    );
    if (pick) await setEnabled(root, false);
  } catch (e) {
    core.logError(root, e);
  }
}

async function setEnabled(root, on) {
  const off = ctx.globalState.get(DISABLED, []).filter((r) => r !== root);
  await ctx.globalState.update(DISABLED, on ? off : [...off, root]);
  if (on) setup.install(root, bin);
  else setup.uninstall(root);
  vscode.window.showInformationMessage(
    on ? `👻 Ghost mode enabled for ${path.basename(root)}.` : `Ghost mode removed from ${path.basename(root)}. Pending drafts stay in .ghost/.`
  );
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
    return newest && path.basename(newest.f, '.jsonl');
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

async function askClaude(root, prompt) {
  const sid = vscode.workspace.getConfiguration('vibeGhost').get('askWithSessionContext', true) && terminalSession(root);
  if (sid) {
    // Fork the terminal session: Claude remembers why it wrote the draft, the original stays untouched.
    try {
      return await runClaude(root, prompt, ['--resume', sid, '--fork-session']);
    } catch {}
  }
  return runClaude(root, prompt, []);
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
  statusItem.text = (off ? '👻 off' : `👻 ${n} to type`) + (marked ? ' · marked' : '');
  statusItem.tooltip =
    (off ? 'Ghost mode off: Claude edits files directly.' : 'Claude drafts waiting for you to type them') +
    (marked ? '\nBaseline marked: run "Ghost: Ghostify changes" after your AI tool is done.' : '');
  statusItem.show();
}

// Paste guard: a big chunk that comes straight out of the draft gets undone.
function onChange(e) {
  scheduleRender();
  const cfg = vscode.workspace.getConfiguration('vibeGhost');
  if (!cfg.get('blockPaste', true) || e.reason !== undefined || !e.document.isDirty) return;
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

async function pickRoot() {
  const rs = roots();
  if (rs.length <= 1) return rs[0];
  const pick = await vscode.window.showQuickPick(rs, { placeHolder: 'Workspace folder' });
  return pick;
}

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
        items.push({ label: rel, description: `${p.total - p.pending}/${p.total} lines typed`, root });
      }
    }
    if (!items.length) return vscode.window.showInformationMessage('No drafts pending. 👻');
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Claude drafts waiting to be typed' });
    if (pick) vscode.window.showTextDocument(vscode.Uri.file(path.join(pick.root, ...pick.label.split('/'))));
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
    const root = rootFor(doc.uri);
    if (!root) return;
    st.context = st.context || partContext(doc, thread.range.start.line);

    st.busy = true;
    const before = [...thread.comments, comment(question, 'You')];
    thread.comments = [...before, comment('$(loading~spin) thinking…', 'Claude')];
    try {
      const answer = await askClaude(root, buildPrompt(st, question));
      st.history.push({ q: question, a: answer });
      thread.comments = [...before, comment(answer, 'Claude')];
    } catch (e) {
      thread.comments = [...before, comment(`⚠️ ${e.message}`, 'Claude')];
    } finally {
      st.busy = false;
    }
  },

  async enableHere() {
    const root = await pickRoot();
    if (root) await setEnabled(root, true);
  },

  async disableHere() {
    const root = await pickRoot();
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
    ...Object.entries(commands).map(([name, fn]) => vscode.commands.registerCommand(`vibeGhost.${name}`, fn))
  );

  ctx = context;
  bin = path.join(context.extensionPath, 'bin', 'ghost.js');
  const addFolder = (folder) => {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${core.DIR}/**`));
    const changed = (uri) => {
      cache.delete(uri.fsPath);
      doneShown.delete(uri.fsPath);
      scheduleRender();
    };
    w.onDidCreate(changed);
    w.onDidChange(changed);
    w.onDidDelete(changed);
    context.subscriptions.push(w);
    autoEnable(folder.uri.fsPath);
  };
  (vscode.workspace.workspaceFolders || []).forEach(addFolder);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((e) => e.added.forEach(addFolder)));

  scheduleRender();
}

function deactivate() {}

module.exports = { activate, deactivate };
