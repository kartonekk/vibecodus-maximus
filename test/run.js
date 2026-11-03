'use strict';
// node test/run.js: alignment unit tests + a full fake Claude turn through the hook CLI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const core = require('../lib/core');

const BIN = path.join(__dirname, '..', 'bin', 'ghost.js');
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

// ---- alignment ----

const ghost = ['function add(a, b) {', '  return a + b;', '}', '', 'module.exports = add;'];

test('empty file pairs first draft line, rest is an insert block', () => {
  const ops = core.align([''], ghost);
  assert.deepStrictEqual(ops[0], { t: 'pair', u: 0, g: 0 });
  assert.deepStrictEqual(ops[1], { t: 'ins', from: 1, to: 5, at: 0 });
  assert.deepStrictEqual(core.lineDiff('', ghost[0]), { kind: 'suffix', text: ghost[0], at: 0 });
});

test('typed prefix shows remaining suffix', () => {
  const user = ['function add(a, b) {', '  ret'];
  const ops = core.align(user, ghost);
  const pair = ops.find((o) => o.t === 'pair');
  assert.deepStrictEqual(pair, { t: 'pair', u: 1, g: 1 });
  assert.deepStrictEqual(core.lineDiff(user[1], ghost[1]), { kind: 'suffix', text: 'urn a + b;', at: 5 });
});

test('fresh blank line pairs with next draft line, not a later blank', () => {
  const user = ['function add(a, b) {', '', 'module.exports = add;'];
  const ops = core.align(user, ghost);
  assert.deepStrictEqual(ops.find((o) => o.t === 'pair'), { t: 'pair', u: 1, g: 1 });
});

test('typo is a mismatch at the right column', () => {
  assert.deepStrictEqual(core.lineDiff('  retrun', '  return a + b;'), { kind: 'mismatch', col: 5 });
});

test('indentation differences are forgiven', () => {
  assert.deepStrictEqual(core.lineDiff('\treturn a + b;', '  return a + b;'), { kind: 'eq' });
});

test('extra user lines flagged', () => {
  const user = [...ghost.slice(0, 2), '  console.log(a);', ...ghost.slice(2)];
  const ops = core.align(user, ghost);
  const live = ops.filter((o) => o.t !== 'eq' && !(o.t === 'pair' && core.lineDiff(user[o.u], ghost[o.g]).kind === 'eq'));
  assert.deepStrictEqual(live, [{ t: 'extra', u: 2 }]);
});

test('progress counts down to done', () => {
  assert.deepStrictEqual(core.progress([''], ghost), { pending: 4, total: 4, done: false });
  assert.deepStrictEqual(core.progress(ghost.map((l) => l.trim()), ghost), { pending: 0, total: 4, done: true });
});

test('hunks group a typed-prefix line with the block below it', () => {
  const user = ['function add(a, b) {', '  ret', '', 'module.exports = add;'];
  const hs = core.hunks(user, ghost);
  assert.deepStrictEqual(hs, [{ lens: 1, start: 1, end: 2, gFrom: 1, gTo: 3 }]);
  assert.strictEqual(core.hunkAt(hs, 0), hs[0]); // thread line sits right above the part
});

test('separate ghost parts stay separate; empty file is one part', () => {
  const g = ['a', 'b', 'c', 'd', 'e'];
  const hs = core.hunks(['a', 'X', 'c', 'Y', 'e'], g);
  assert.deepStrictEqual(hs.map((h) => [h.lens, h.gFrom, h.gTo]), [[1, 1, 2], [3, 3, 4]]);
  assert.strictEqual(core.hunkAt(hs, 3), hs[1]);
  assert.deepStrictEqual(core.hunks([''], ghost), [{ lens: 0, start: 0, end: 0, gFrom: 0, gTo: 5 }]);
});

test('pure insert block: lens sits on the line where the block goes', () => {
  const hs = core.hunks(['a', 'e'], ['a', 'b', 'c', 'e']);
  assert.deepStrictEqual(hs, [{ lens: 1, start: 0, end: 0, gFrom: 1, gTo: 3 }]);
});

test('auto-closed quote/bracket is a gap to fill, not a typo', () => {
  const draft = '        : "Trwa podmiana kontenerów"';
  // VS Code put the closing quote in for you
  assert.deepStrictEqual(core.lineDiff('        : "Trwa podmiana konteneró"', draft), { kind: 'suffix', text: 'w', at: 34 });
  assert.deepStrictEqual(core.lineDiff('foo()', 'foo(a, b)'), { kind: 'suffix', text: 'a, b', at: 4 });
  // a real typo stays a typo
  assert.strictEqual(core.lineDiff('        : "Trwa podmiana kontenero"', draft).kind, 'mismatch');
  // ghost at the gap keeps the closing quote after it
  const u = ['x', '        : "Trwa podmiana konteneró"'];
  assert.strictEqual(core.ghostAt(u, ['x', draft], 1, 34), 'w"');
  assert.strictEqual(core.ghostAt(u, ['x', draft], 1, 20), null, 'cursor not at the gap');
  assert.deepStrictEqual(core.tabFill(['// abc def'], ['// abc def ghi'], 0, 10, 'typescript'), { line: 0, from: 10, to: 10, text: ' ghi' });
});

test('auto-closed bracket mid-line: ghost inside and after it', () => {
  const draft = 'if (ok(a), b) {';
  assert.deepStrictEqual(core.lineDiff('if ()', draft), { kind: 'suffix', text: 'ok(a), b', at: 4, more: [{ at: 5, text: ' {' }] });
  assert.strictEqual(core.ghostAt(['if ()'], [draft], 0, 4), 'ok(a), b) {');
  // nested auto-close: `if (ok())`
  assert.deepStrictEqual(core.lineDiff('if (ok())', draft), { kind: 'suffix', text: 'a', at: 7, more: [{ at: 8, text: ', b' }, { at: 9, text: ' {' }] });
  assert.strictEqual(core.ghostAt(['if (ok())'], [draft], 0, 7), 'a), b) {');
  assert.strictEqual(core.lineDiff('x = "";', 'x = "hi";').text, 'hi');
  assert.strictEqual(core.lineDiff('if (x)', draft).kind, 'mismatch');
});

test('ghostAt: rest of line + block below, typed over as you go', () => {
  // empty file: whole draft is ghost text at the cursor
  assert.strictEqual(core.ghostAt([''], ghost, 0, 0), ghost.join('\n'));
  // half-typed line: remainder of it, then the lines still to come
  const user = ['function add(a, b) {', '  ret'];
  assert.strictEqual(core.ghostAt(user, ghost, 1, 5), 'urn a + b;\n}\n\nmodule.exports = add;');
  // end of a finished line with new lines due below it
  assert.strictEqual(core.ghostAt(['a', 'e'], ['a', 'b', 'c', 'e'], 0, 1), '\nb\nc');
  // typo or cursor mid-line: nothing
  assert.strictEqual(core.ghostAt(['function add(a, b) {', '  rx'], ghost, 1, 4), null);
  assert.strictEqual(core.ghostAt(['function add(a, b) {', '  ret'], ghost, 1, 3), null);
  // fully typed: nothing
  assert.strictEqual(core.ghostAt(ghost, ghost, 1, 16), null);
});

test('commentLines: /** */ blocks, //, # (not where # is code)', () => {
  const ts = ['/**', ' * Goes up.', ' */', 'const x = 1; // trailing', '// whole line', '/* one */', '/* a */ code()', '  * 2', '#x'];
  assert.deepStrictEqual([...core.commentLines(ts, 'typescript')].sort(), [0, 1, 2, 4, 5, 8]);
  assert.deepStrictEqual([...core.commentLines(['# note', 'x = 1  # inline', '"""doc"""'], 'python')], [0, 2]);
  assert.deepStrictEqual([...core.commentLines(['#header {', '/* c */'], 'css')], [1]);
});

test('commentLines: Python """/\'\'\' docstrings count, Java text blocks don\'t', () => {
  const py = [
    'def status(mongo):', // 0
    '    """Return the active deploy status.', // 1
    '', // 2
    '    None when nothing runs.', // 3
    '    """', // 4
    '    x = """not a docstring"""', // 5
    "    r'''raw one-liner'''", // 6
    '    """one""" + extra', // 7 code after the closing quotes
    '    return None', // 8
  ];
  assert.deepStrictEqual([...core.commentLines(py, 'python')].sort((a, b) => a - b), [1, 2, 3, 4, 6]);
  const java = ['String q = """', '    SELECT 1', '    """;'];
  assert.deepStrictEqual([...core.commentLines(java, 'java')], []);
});

test('tabFill: one comment line per Tab, never code', () => {
  const g = ['def f():', '    # explain', '    return 1'];
  // end of "def f():" with a comment due below: newline + that line only
  assert.deepStrictEqual(core.tabFill(['def f():'], g, 0, 8, 'python'), { line: 0, from: 8, to: 8, text: '\n    # explain' });
  // empty / indented line where it goes: whole line, cursor anywhere in the indentation
  assert.deepStrictEqual(core.tabFill(['def f():', ''], g, 1, 0, 'python'), { line: 1, from: 0, to: 0, text: '    # explain' });
  assert.deepStrictEqual(core.tabFill(['def f():', '    '], g, 1, 2, 'python'), { line: 1, from: 0, to: 4, text: '    # explain' });
  // half-typed comment: the rest of it
  assert.deepStrictEqual(core.tabFill(['def f():', '    # exp'], g, 1, 9, 'python'), { line: 1, from: 9, to: 9, text: 'lain' });
  // Claude edited an existing comment (your old line differs): swap in the draft's line
  const gd = ['x', '    uprawnienia `developer`. `deploy_status` też', '    """'];
  const ud = ['x', '    uprawnienia `developer`."""'];
  // (inside a docstring in the draft; your line ends one)
  const gdoc = ['def f():', '    """Pulse.', ...gd.slice(1)];
  const udoc = ['def f():', '    """Pulse.', ud[1]];
  assert.deepStrictEqual(core.tabFill(udoc, gdoc, 2, udoc[2].length, 'python'), { line: 2, from: 0, to: udoc[2].length, text: gdoc[2] });
  // code line: never
  assert.strictEqual(core.tabFill(['def f():', '    # explain', '    ret'], g, 2, 7, 'python'), null);
  // the file's final empty line got paired with the comment: Tab at the end of the line above
  // still puts it in under the cursor (and the chain continues)
  const jd = ['const a = 1;', '/**', ' * Status.', ' */', 'export const b = 2;', ''];
  let ju = ['const a = 1;', ''];
  for (let i = 0; i < 3; i++) {
    const line = i;
    const f = core.tabFill(ju, jd, line, ju[line].length, 'typescript');
    assert.ok(f, `Tab ${i + 1} filled`);
    ju = core.splitLines(ju.join('\n').split('\n').map((l, k) => (k === f.line ? l.slice(0, f.from) + f.text + l.slice(f.to) : l)).join('\n'));
  }
  assert.deepStrictEqual(ju, ['const a = 1;', '/**', ' * Status.', ' */', '']);
  assert.strictEqual(core.tabFill(ju, jd, 3, 3, 'typescript'), null, 'code next: no fill');
  // blank draft lines before the comment come along
  assert.deepStrictEqual(core.tabFill(['a'], ['a', '', '// c'], 0, 1, 'typescript'), { line: 0, from: 1, to: 1, text: '\n\n// c' });
});

// ---- full turn through the hook CLI ----

function hook(root, payload) {
  const r = spawnSync('node', [BIN, 'hook'], {
    input: JSON.stringify({ cwd: root, ...payload }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ghost-'));
execSync('git init -q', { cwd: tmp });
const run = (args) => spawnSync('node', [BIN, ...args], { cwd: tmp, encoding: 'utf8' });
const read = (rel) => fs.readFileSync(path.join(tmp, rel), 'utf8');

test('install wires hooks, gitignore, pre-commit', () => {
  fs.writeFileSync(path.join(tmp, 'app.js'), 'const x = 1;\n');
  assert.strictEqual(run(['install', tmp]).status, 0);
  const s = JSON.parse(read('.claude/settings.local.json'));
  for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) assert.ok(s.hooks[e].length === 1, e);
  assert.match(read('.gitignore'), /^\.ghost\/$/m);
  assert.match(read('.git/hooks/pre-commit'), /precommit/);
  run(['install', tmp]); // idempotent
  assert.strictEqual(JSON.parse(read('.claude/settings.local.json')).hooks.Stop.length, 1);
});

test('Claude turn: edits become drafts, user file restored', () => {
  const old = new Date('2020-01-01');
  fs.utimesSync(path.join(tmp, 'app.js'), old, old);
  hook(tmp, { hook_event_name: 'UserPromptSubmit', prompt: 'add stuff' });
  // Claude edits an existing file and creates a new one
  hook(tmp, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'app.js') } });
  fs.writeFileSync(path.join(tmp, 'app.js'), 'const x = 1;\nconst y = 2;\n');
  hook(tmp, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'lib', 'new.js') } });
  fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'lib', 'new.js'), 'export const hi = 1;\n');
  assert.ok(core.isActive(tmp));

  const out = hook(tmp, { hook_event_name: 'Stop' });
  assert.match(JSON.parse(out).systemMessage, /2 draft/);
  assert.strictEqual(read('app.js'), 'const x = 1;\n');
  // restored file must look NEWER than Claude's version, or VS Code keeps showing Claude's code
  assert.ok(fs.statSync(path.join(tmp, 'app.js')).mtimeMs > Date.now() - 60000, 'restore gets a fresh mtime');
  assert.strictEqual(read('lib/new.js'), '');
  assert.strictEqual(read('.ghost/files/app.js'), 'const x = 1;\nconst y = 2;\n');
  assert.deepStrictEqual(core.listGhosts(tmp), ['app.js', 'lib/new.js']);
  assert.ok(!core.isActive(tmp));
});

test('next turn: Claude sees its own draft, user progress survives', () => {
  fs.writeFileSync(path.join(tmp, 'app.js'), 'const x = 1;\nconst y'); // user typing
  const ctx = hook(tmp, { hook_event_name: 'UserPromptSubmit', prompt: 'more' });
  assert.match(ctx, /app\.js: user typed 1\/2 lines/);
  assert.strictEqual(read('app.js'), 'const x = 1;\nconst y = 2;\n'); // draft on disk for Claude
  hook(tmp, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(tmp, 'app.js') } });
  fs.writeFileSync(path.join(tmp, 'app.js'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
  hook(tmp, { hook_event_name: 'Stop' });
  assert.strictEqual(read('app.js'), 'const x = 1;\nconst y'); // user's typing intact
  assert.strictEqual(read('.ghost/files/app.js'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
});

test('pre-commit blocks while drafts are on disk', () => {
  hook(tmp, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  assert.strictEqual(run(['precommit']).status, 1);
  hook(tmp, { hook_event_name: 'SessionStart' }); // interrupted turn recovered
  assert.ok(!core.isActive(tmp));
  assert.strictEqual(run(['precommit']).status, 0);
});

test('unchanged draft that user fully typed disappears', () => {
  fs.writeFileSync(path.join(tmp, 'lib', 'new.js'), 'export const hi = 1;\n');
  hook(tmp, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  hook(tmp, { hook_event_name: 'Stop' });
  assert.ok(!fs.existsSync(path.join(tmp, '.ghost', 'files', 'lib', 'new.js')));
});

test('VIBE_GHOST_SKIP (questions from VS Code) leaves files alone', () => {
  const r = spawnSync('node', [BIN, 'hook'], {
    input: JSON.stringify({ cwd: tmp, hook_event_name: 'UserPromptSubmit', prompt: 'q' }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, VIBE_GHOST_SKIP: '1' },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(!core.isActive(tmp));
});

test('off: Claude edits go straight through', () => {
  run(['off', tmp]);
  hook(tmp, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  hook(tmp, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'b.js') } });
  assert.ok(!core.isActive(tmp));
  run(['on', tmp]);
});

const gitc = (args) => execSync(`git -c user.name=t -c user.email=t@t ${args}`, { cwd: tmp, stdio: 'pipe' }).toString();
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};

test('mark + ghostify: other tool edits become drafts, earlier typing stays', () => {
  for (const g of core.listGhosts(tmp)) fs.rmSync(core.ghostFile(tmp, g));
  write('app.js', 'const x = 1;\n');
  write('old.js', 'bye\n');
  gitc('add -A');
  gitc('commit -qm base');
  write('app.js', 'const x = 1;\n// typed by me\n'); // uncommitted user typing
  assert.strictEqual(run(['mark', tmp]).status, 0);
  // "Cursor" does its thing
  write('app.js', 'const x = 1;\n// typed by me\nconst ai = 2;\n');
  write('src/new.js', 'export default 42;\n');
  fs.rmSync(path.join(tmp, 'old.js'));
  fs.writeFileSync(path.join(tmp, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));

  const precommit = run(['precommit']);
  assert.strictEqual(precommit.status, 1, 'pre-commit blocks while marked');

  const r = run(['ghostify', tmp]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(read('app.js'), 'const x = 1;\n// typed by me\n');
  assert.strictEqual(read('.ghost/files/app.js'), 'const x = 1;\n// typed by me\nconst ai = 2;\n');
  assert.strictEqual(read('src/new.js'), '');
  assert.strictEqual(read('.ghost/files/src/new.js'), 'export default 42;\n');
  assert.strictEqual(read('old.js'), 'bye\n');
  assert.strictEqual(read('.ghost/files/old.js'), '');
  assert.ok(fs.existsSync(path.join(tmp, 'logo.bin')), 'binary left alone');
  assert.match(r.stdout, /kept\s+logo\.bin/);
  assert.strictEqual(core.readMark(tmp), null);
  assert.strictEqual(gitc('diff --cached --name-only').trim(), '', 'real index untouched');
});

test('ghostify without mark diffs against HEAD', () => {
  for (const g of core.listGhosts(tmp)) fs.rmSync(core.ghostFile(tmp, g));
  fs.rmSync(path.join(tmp, 'logo.bin'));
  fs.rmSync(path.join(tmp, 'src'), { recursive: true });
  write('app.js', 'const x = 1;\n');
  write('app.js', 'const x = 1;\nconst y = 2;\n');
  const { base, drafted } = core.ghostify(tmp);
  assert.strictEqual(base, 'HEAD');
  assert.deepStrictEqual(drafted, ['app.js']);
  assert.strictEqual(read('app.js').replace(/\r\n/g, '\n'), 'const x = 1;\n'); // EOL as checkout would give
});

test('ghostify keeps CRLF files CRLF under autocrlf', () => {
  for (const g of core.listGhosts(tmp)) fs.rmSync(core.ghostFile(tmp, g));
  gitc('config core.autocrlf true');
  write('win.txt', 'one\r\ntwo\r\n');
  gitc('add -A');
  gitc('commit -qm crlf');
  core.mark(tmp);
  write('win.txt', 'one\r\ntwo\r\nthree\r\n');
  core.ghostify(tmp);
  assert.strictEqual(read('win.txt'), 'one\r\ntwo\r\n');
  gitc('config core.autocrlf false');
});

test('run -- <cmd>: mark, run, ghostify', () => {
  for (const g of core.listGhosts(tmp)) fs.rmSync(core.ghostFile(tmp, g));
  write('app.js', 'const x = 1;\n');
  const r = run(['run', '--', 'node', '-e', "require('fs').appendFileSync('app.js', 'tool();\\n')"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(read('app.js'), 'const x = 1;\n');
  assert.strictEqual(read('.ghost/files/app.js'), 'const x = 1;\ntool();\n');
});

test('auto-enable: quiet when nothing changed, repoints hooks after extension update', () => {
  const setup = require('../lib/install');
  assert.ok(setup.isInstalled(tmp) && setup.isRepo(tmp));
  assert.deepStrictEqual(setup.install(tmp, BIN), [], 'second run writes nothing');
  const moved = path.join(tmp, 'ext-0.9.0', 'bin', 'ghost.js');
  const changed = setup.install(tmp, moved);
  assert.strictEqual(changed.length, 2); // settings + pre-commit
  const settings = read('.claude/settings.local.json');
  assert.ok(settings.includes('ext-0.9.0') && !settings.includes(BIN.split(path.sep).join('/')));
  const pc = read('.git/hooks/pre-commit');
  assert.strictEqual(pc.split('vibecodus-maximus').length - 1, 1, 'one guard line, not two');
  assert.match(pc, /ext-0\.9\.0/);
  setup.install(tmp, BIN);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-plain-'));
  assert.ok(!setup.isRepo(plain));
  fs.rmSync(plain, { recursive: true });
});

test('sub-repos: claude started in the parent folder drafts into the file\'s own repo', () => {
  const setup = require('../lib/install');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-parent-'));
  const sub = path.join(parent, 'console');
  fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
  execSync('git init -q', { cwd: sub });
  fs.writeFileSync(path.join(sub, 'src', 'a.ts'), 'const a = 1;\n');

  const { repos } = setup.enableTree(parent, BIN);
  assert.deepStrictEqual(repos, [sub]);
  assert.ok(setup.isInstalled(parent), 'hooks at the parent (claude may start there)');
  assert.ok(setup.isInstalled(sub), 'hooks in the sub-repo');
  assert.ok(!fs.existsSync(path.join(parent, '.gitignore')), 'no .gitignore in a non-repo parent');

  const session = { session_id: 'sub-test' };
  hook(parent, { ...session, hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  const file = path.join(sub, 'src', 'a.ts');
  hook(parent, { ...session, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
  const out = hook(parent, { ...session, hook_event_name: 'Stop' });
  assert.match(JSON.parse(out).systemMessage, /console\/src\/a\.ts/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'const a = 1;\n', 'user file restored');
  assert.strictEqual(fs.readFileSync(core.ghostFile(sub, 'src/a.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\n');
  assert.ok(!fs.existsSync(path.join(parent, '.ghost', 'files', 'console')), 'nothing parked in the parent');
  assert.strictEqual(core.ghostRootFor(file), sub);
  assert.deepStrictEqual(core.nestedRoots(parent), [sub]);

  // next prompt from the parent: the sub-repo draft is swapped in for Claude
  hook(parent, { ...session, hook_event_name: 'UserPromptSubmit', prompt: 'y' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'const a = 1;\nconst b = 2;\n');
  hook(parent, { ...session, hook_event_name: 'Stop' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'const a = 1;\n');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('repo nobody installed in: .ghost/ kept out of git status via info/exclude', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-bare-'));
  execSync('git init -q', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'x.js'), 'x\n');
  core.swapIn(repo, 'x.js', { write: true });
  fs.writeFileSync(path.join(repo, 'x.js'), 'x\ny\n');
  core.swapOut(repo);
  const status = execSync('git status --porcelain', { cwd: repo }).toString();
  assert.doesNotMatch(status, /\.ghost/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('direct files: Claude\'s *.md/*.css edits land for real, code still becomes a draft', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-direct-'));
  execSync('git init -q', { cwd: repo });
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  w('src/a.ts', 'a\n');
  w('src/CLAUDE.md', 'docs\n');
  w('styles/x.css', '.a{}\n');
  hook(repo, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  for (const rel of ['src/a.ts', 'src/CLAUDE.md', 'styles/x.css']) {
    hook(repo, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo, rel) } });
  }
  w('src/a.ts', 'a\nb\n');
  w('src/CLAUDE.md', 'docs\nmore docs\n');
  w('styles/x.css', '.a{}\n.b{}\n');
  hook(repo, { hook_event_name: 'Stop' });
  const r = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  assert.strictEqual(r('src/a.ts'), 'a\n', 'code restored, waits as a draft');
  assert.deepStrictEqual(core.listGhosts(repo), ['src/a.ts']);
  assert.strictEqual(r('src/CLAUDE.md'), 'docs\nmore docs\n', 'md applied directly');
  assert.strictEqual(r('styles/x.css'), '.a{}\n.b{}\n', 'css applied directly');

  // config override + old drafts made before the rule get applied
  fs.writeFileSync(core.paths(repo).config, JSON.stringify({ direct: ['*.md', '*.css', 'src/*.ts'] }));
  assert.ok(core.isDirect(repo, 'src/a.ts') && !core.isDirect(repo, 'lib/a.ts'));
  assert.deepStrictEqual(core.applyDirect(repo), ['src/a.ts']);
  assert.strictEqual(r('src/a.ts'), 'a\nb\n');
  assert.deepStrictEqual(core.listGhosts(repo), []);
  assert.ok(core.isDirect(repo, 'README.MD'), 'case-insensitive');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('uninstall removes hooks', () => {
  run(['uninstall', tmp]);
  assert.deepStrictEqual(JSON.parse(read('.claude/settings.local.json')).hooks, {});
  assert.doesNotMatch(read('.git/hooks/pre-commit'), /precommit/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
