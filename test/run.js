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
  assert.deepStrictEqual(core.lineDiff('', ghost[0]), { kind: 'suffix', text: ghost[0] });
});

test('typed prefix shows remaining suffix', () => {
  const user = ['function add(a, b) {', '  ret'];
  const ops = core.align(user, ghost);
  const pair = ops.find((o) => o.t === 'pair');
  assert.deepStrictEqual(pair, { t: 'pair', u: 1, g: 1 });
  assert.deepStrictEqual(core.lineDiff(user[1], ghost[1]), { kind: 'suffix', text: 'urn a + b;' });
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

test('uninstall removes hooks', () => {
  run(['uninstall', tmp]);
  assert.deepStrictEqual(JSON.parse(read('.claude/settings.local.json')).hooks, {});
  assert.doesNotMatch(read('.git/hooks/pre-commit'), /precommit/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
