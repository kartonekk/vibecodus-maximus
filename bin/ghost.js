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
//   node bin/ghost.js apply-direct [dir]            apply drafts of *.md/*.css (no typing needed)
//   node bin/ghost.js precommit         (called from .git/hooks/pre-commit)

const fs = require('fs');
const os = require('os');
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
  // The folder claude runs in. It may hold several repos (sub-repos); each keeps its own .ghost.
  const project = process.env.CLAUDE_PROJECT_DIR || core.findRoot(data.cwd || process.cwd());
  try {
    handle(project, data);
  } catch (err) {
    core.logError(core.findRoot(project), err); // never break Claude over this
  }
  process.exit(0);
}

// Repos touched this session that live outside the project folder, so Stop finds them too.
const touchedFile = (data) => path.join(os.tmpdir(), `vibe-ghost-${String(data.session_id || 'x').replace(/[^\w-]/g, '')}.json`);

function touched(data) {
  try {
    return JSON.parse(fs.readFileSync(touchedFile(data), 'utf8'));
  } catch {
    return [];
  }
}

// Every ghost root this hook cares about: the project's repo, repos below it, repos touched.
function rootsFor(project, data) {
  return [...new Set([core.findRoot(project), ...core.nestedRoots(project), ...touched(data)])];
}

const shown = (project, root, rel) => path.relative(project, path.join(root, rel)).split(path.sep).join('/');

function handle(project, data) {
  const event = data.hook_event_name;

  if (event === 'SessionStart') {
    for (const r of rootsFor(project, data)) if (core.isActive(r)) core.swapOut(r); // interrupted turn
    return;
  }

  if (event === 'UserPromptSubmit') {
    const roots = rootsFor(project, data);
    for (const r of roots) if (core.isActive(r)) core.swapOut(r);
    const on = roots.filter((r) => !core.isOff(r));
    if (!on.length) return;
    const pending = [];
    const direct = new Set();
    for (const r of on) {
      core.applyDirect(r); // drafts of files that no longer need typing
      core.config(r).direct.forEach((p) => direct.add(p));
      for (const rel of core.listGhosts(r)) {
        const p = core.fileProgress(r, rel);
        pending.push(`  ${shown(project, r, rel)}: user typed ${p.total - p.pending}/${p.total} lines`);
      }
      core.swapInAll(r);
    }
    process.stdout.write(
      [
        '[ghost mode] Your file edits are NOT applied to the user\'s code. When your turn ends they become',
        'ghost drafts the user retypes by hand in VS Code; only what they type gets committed.',
        'During your turn the disk holds your drafts, so read/edit/test as normal. Keep diffs small and',
        'focused: the user types every line. Never touch .ghost/. The user\'s real typed version of a',
        'drafted file is at <its repo>/.ghost/user/<path> while you work.',
        `Exception: edits to ${[...direct].join(', ')} files are applied directly (nobody retypes those).`,
        ...(pending.length ? ['Pending drafts:', ...pending] : []),
      ].join('\n') + '\n'
    );
    return;
  }

  if (event === 'PreToolUse') {
    const file = (data.tool_input || {}).file_path;
    if (!file) return;
    const abs = path.resolve(data.cwd || project, file);
    // The draft goes to the file's own repo, not necessarily the folder claude started in.
    const root = core.closestRoot(path.dirname(abs)) || project;
    if (core.isOff(root)) return;
    const rel = core.relOf(root, abs);
    if (!rel) return;
    if (core.swapIn(root, rel, { write: WRITE_TOOLS.has(data.tool_name) })) {
      const list = touched(data);
      if (!list.includes(root)) fs.writeFileSync(touchedFile(data), JSON.stringify([...list, root]));
    }
    return;
  }

  if (event === 'Stop') {
    const drafted = [];
    for (const r of rootsFor(project, data)) {
      if (core.isActive(r)) drafted.push(...core.swapOut(r).map((rel) => shown(project, r, rel)));
    }
    if (drafted.length) {
      const msg = `👻 ${drafted.length} draft(s) to type: ${drafted.join(', ')}`;
      process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
    }
  }
}

// ---- install ----

function install(dir) {
  const { changed, repos } = setup.enableTree(path.resolve(dir), SELF);
  for (const p of changed) console.log(`updated ${p}`);
  if (!changed.length) console.log('Already set up.');
  if (!repos.length) console.log('No git repo here or below: hooks only, no pre-commit guard (run install again after git init).');
  else console.log(`Repos: ${repos.join(', ')}`);
  console.log('\nDone. Restart claude in that folder; open it in VS Code with the extension installed.');
}

function uninstall(dir) {
  setup.disableTree(path.resolve(dir));
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
  case 'apply-direct': {
    // existing drafts of docs/styles (or whatever .ghost/config.json lists): apply them, no typing
    const root = target();
    const applied = core.applyDirect(root);
    for (const rel of applied) console.log(`applied ${rel}`);
    console.log(applied.length ? `${applied.length} direct file(s) applied.` : 'No direct drafts.');
    break;
  }
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

function report({ base, drafted, skipped, direct }) {
  console.log(`\n👻 Changes since ${base === 'mark' ? 'your mark' : 'last commit (no mark set)'}:`);
  if (!drafted.length) console.log('   nothing to type.');
  for (const rel of drafted) console.log(`   draft  ${rel}`);
  for (const rel of direct) console.log(`   kept   ${rel} (docs/styles, applied directly)`);
  for (const rel of skipped) console.log(`   kept   ${rel} (binary, left as the tool wrote it)`);
}
