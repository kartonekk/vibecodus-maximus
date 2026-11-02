#!/usr/bin/env node
'use strict';
// Claude Code hook entry point + small CLI.
//
//   node bin/ghost.js hook              (wired into .claude/settings.local.json)
//   node bin/ghost.js install [dir]     wire a project up
//   node bin/ghost.js uninstall [dir]
//   node bin/ghost.js status|out|on|off [dir]
//   node bin/ghost.js mark|ghostify|unmark [dir]   for AI tools without hooks
//   node bin/ghost.js run -- <tool> [args...]       mark + run + ghostify
//   node bin/ghost.js precommit         (called from .git/hooks/pre-commit)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const core = require('../lib/core');
const setup = require('../lib/install');

const SELF = path.resolve(__filename).split(path.sep).join('/');
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function hook() {
  // Questions asked from VS Code run a separate read-only claude; leave the files alone.
  if (process.env.VIBE_GHOST_SKIP) process.exit(0);
  let data = {};
  try {
    data = JSON.parse(readStdin() || '{}');
  } catch {}
  const root = process.env.CLAUDE_PROJECT_DIR || core.findRoot(data.cwd || process.cwd());
  try {
    handle(root, data);
  } catch (err) {
    core.logError(root, err); // never break Claude over this
  }
  process.exit(0);
}

function handle(root, data) {
  const event = data.hook_event_name;
  const off = core.isOff(root);

  if (event === 'SessionStart') {
    if (core.isActive(root)) core.swapOut(root); // previous turn was interrupted
    return;
  }

  if (event === 'UserPromptSubmit') {
    if (core.isActive(root)) core.swapOut(root);
    if (off) return;
    const pending = core.listGhosts(root).map((rel) => {
      const p = core.fileProgress(root, rel);
      return `  ${rel}: user typed ${p.total - p.pending}/${p.total} lines`;
    });
    core.swapInAll(root);
    process.stdout.write(
      [
        '[ghost mode] Your file edits are NOT applied to the user\'s code. When your turn ends they become',
        'ghost drafts the user retypes by hand in VS Code; only what they type gets committed.',
        'During your turn the disk holds your drafts, so read/edit/test as normal. Keep diffs small and',
        'focused: the user types every line. Never touch .ghost/. The user\'s real typed version of a',
        'drafted file is at .ghost/user/<path> while you work.',
        ...(pending.length ? ['Pending drafts:', ...pending] : []),
      ].join('\n') + '\n'
    );
    return;
  }

  if (event === 'PreToolUse') {
    if (off) return;
    const input = data.tool_input || {};
    const file = input.file_path;
    if (!file) return;
    const rel = core.relOf(root, path.resolve(data.cwd || root, file));
    if (!rel) return;
    core.swapIn(root, rel, { write: WRITE_TOOLS.has(data.tool_name) });
    return;
  }

  if (event === 'Stop') {
    if (!core.isActive(root)) return;
    const drafted = core.swapOut(root);
    if (drafted.length) {
      const msg = `👻 ${drafted.length} draft(s) to type: ${drafted.join(', ')}`;
      process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
    }
  }
}

// ---- install ----

function install(dir) {
  const root = path.resolve(dir);
  const changed = setup.install(root, SELF);
  for (const p of changed) console.log(`updated ${p}`);
  if (!changed.length) console.log('Already set up.');
  if (!setup.isRepo(root)) console.log('Not a git repo: skipped the pre-commit guard (run install again after git init).');
  console.log('\nDone. Restart claude in that folder; open it in VS Code with the extension installed.');
}

function uninstall(dir) {
  setup.uninstall(path.resolve(dir));
  console.log('Hooks removed. Drafts kept in .ghost/files (delete the folder to drop them).');
}

function status(root) {
  if (core.isActive(root)) console.log('Claude turn in progress (drafts are on disk right now).');
  if (core.isOff(root)) console.log('Ghost mode is OFF.');
  const ghosts = core.listGhosts(root);
  if (!ghosts.length) return console.log('No drafts pending.');
  for (const rel of ghosts) {
    const p = core.fileProgress(root, rel);
    console.log(`${String(p.total - p.pending).padStart(5)}/${String(p.total).padEnd(5)} ${rel}`);
  }
}

function precommit() {
  const root = core.findRoot(process.cwd());
  if (core.isActive(root)) {
    console.error(
      'vibecodus-maximus: Claude\'s drafts are on disk right now (turn running or interrupted).\n' +
        `Wait for Claude to finish, or restore your files with: node "${SELF}" out`
    );
    process.exit(1);
  }
  if (core.readMark(root)) {
    console.error(
      'vibecodus-maximus: a baseline is marked, so an AI tool may have written code since.\n' +
        `Turn it into drafts with: node "${SELF}" ghostify   (or drop the mark: unmark)`
    );
    process.exit(1);
  }
  const n = core.listGhosts(root).length;
  if (n) console.error(`vibecodus-maximus: ${n} draft(s) still untyped; committing only what you wrote.`);
}

const [cmd, arg] = process.argv.slice(2);
const target = () => core.findRoot(arg || process.cwd());

switch (cmd) {
  case 'hook':
    hook();
    break;
  case 'install':
    install(arg || process.cwd());
    break;
  case 'uninstall':
    uninstall(arg || process.cwd());
    break;
  case 'status':
    status(target());
    break;
  case 'out': {
    const drafted = core.swapOut(target());
    console.log(drafted.length ? `Restored your files; drafts: ${drafted.join(', ')}` : 'Nothing to restore.');
    break;
  }
  case 'mark':
    core.mark(target());
    console.log('Baseline marked. Run your AI tool, then: ghostify');
    break;
  case 'unmark':
    core.unmark(target());
    console.log('Baseline dropped.');
    break;
  case 'ghostify':
    report(core.ghostify(target()));
    break;
  case 'run': {
    // ghost.js run -- <tool> [args...]: mark, run the tool, ghostify what it changed
    const rest = process.argv.slice(process.argv.indexOf('--') + 1);
    if (!process.argv.includes('--') || !rest.length) {
      console.log('usage: ghost.js run -- <command> [args...]');
      process.exit(1);
    }
    const root = core.findRoot(process.cwd());
    core.mark(root);
    const line = rest.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
    const r = spawnSync(line, { stdio: 'inherit', shell: true });
    report(core.ghostify(root));
    process.exit(r.status || 0);
  }
  case 'on':
  case 'off':
    core.setOff(target(), cmd === 'off');
    console.log(`Ghost mode ${cmd.toUpperCase()}.`);
    break;
  case 'precommit':
    precommit();
    break;
  default:
    console.log('usage: ghost.js install|uninstall|status|out|on|off|mark|unmark|ghostify [dir]');
    console.log('       ghost.js run -- <command> [args...]');
}

function report({ base, drafted, skipped }) {
  console.log(`\n👻 Changes since ${base === 'mark' ? 'your mark' : 'last commit (no mark set)'}:`);
  if (!drafted.length) console.log('   nothing to type.');
  for (const rel of drafted) console.log(`   draft  ${rel}`);
  for (const rel of skipped) console.log(`   kept   ${rel} (binary, left as the tool wrote it)`);
}
