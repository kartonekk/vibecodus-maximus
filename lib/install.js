'use strict';
// Wire a project up for ghost mode. Shared by `ghost.js install` and the extension's auto-enable.
// Idempotent and quiet: files are only written when something actually changes, and re-running
// with a new `bin` path (extension updated) just repoints the hooks.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('./core');

const MARKER = '# vibecodus-maximus';
const isOurs = (group) => (group.hooks || []).some((h) => /ghost\.js"? hook/.test(h.command || ''));
const slash = (p) => path.resolve(p).split(path.sep).join('/');

function settingsPath(root) {
  return path.join(root, '.claude', 'settings.local.json');
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeIfChanged(p, text, mode) {
  if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, mode ? { mode } : undefined);
  return true;
}

// Where git looks for hooks (handles worktrees, submodules, core.hooksPath). null if not a repo.
function hooksDir(root) {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return path.resolve(root, dir.trim());
  } catch {
    return null;
  }
}

const isRepo = (root) => hooksDir(root) !== null;

// Already ignored by some rule (global excludes, a parent .gitignore, `.claude/`…)?
function ignored(root, rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isInstalled(root) {
  const hooks = readJson(settingsPath(root)).hooks || {};
  return Object.values(hooks).some((groups) => groups.some(isOurs));
}

// Returns the files it changed. `hooksOnly` for a plain folder that holds repos: just the
// Claude hooks, so a `claude` started there works; drafts still go to each file's own repo.
function install(root, bin, { hooksOnly = false } = {}) {
  const cmd = `node "${slash(bin)}"`;
  const changed = [];
  if (!hooksOnly) fs.mkdirSync(core.paths(root).files, { recursive: true });

  // .claude/settings.local.json: local, because the hook path is machine-specific
  const sp = settingsPath(root);
  const settings = readJson(sp);
  settings.hooks = settings.hooks || {};
  const entry = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `${cmd} hook`, timeout: 30 }] });
  const want = {
    SessionStart: entry(),
    UserPromptSubmit: entry(),
    PreToolUse: entry('Read|Edit|Write|MultiEdit'),
    Stop: entry(),
  };
  for (const [event, e] of Object.entries(want)) {
    settings.hooks[event] = [...(settings.hooks[event] || []).filter((g) => !isOurs(g)), e];
  }
  if (writeIfChanged(sp, JSON.stringify(settings, null, 2) + '\n')) changed.push(sp);
  if (hooksOnly) return changed;

  // .gitignore: the drafts, and the settings file holding this machine's hook path
  const gi = path.join(root, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = ['.ghost/', '.claude/settings.local.json'].filter((line) => !ignored(root, line));
  if (missing.length) {
    writeIfChanged(gi, giText + (giText && !giText.endsWith('\n') ? '\n' : '') + missing.map((l) => l + '\n').join(''));
    changed.push(gi);
  }

  // pre-commit: no commits while Claude's drafts are on disk or a baseline is marked
  const hd = hooksDir(root);
  if (hd) {
    const pc = path.join(hd, 'pre-commit');
    const ours = `${cmd} precommit || exit 1 ${MARKER}`;
    const lines = (fs.existsSync(pc) ? fs.readFileSync(pc, 'utf8') : '#!/bin/sh\n').split('\n').filter((l) => !l.includes(MARKER));
    lines.splice(lines[0].startsWith('#!') ? 1 : 0, 0, ours);
    if (writeIfChanged(pc, lines.join('\n'), 0o755)) changed.push(pc);
  }
  return changed;
}

function uninstall(root) {
  const sp = settingsPath(root);
  if (fs.existsSync(sp)) {
    const settings = readJson(sp);
    for (const event of Object.keys(settings.hooks || {})) {
      settings.hooks[event] = settings.hooks[event].filter((g) => !isOurs(g));
      if (!settings.hooks[event].length) delete settings.hooks[event];
    }
    writeIfChanged(sp, JSON.stringify(settings, null, 2) + '\n');
  }
  const hd = hooksDir(root);
  const pc = hd && path.join(hd, 'pre-commit');
  if (pc && fs.existsSync(pc)) {
    writeIfChanged(pc, fs.readFileSync(pc, 'utf8').split('\n').filter((l) => !l.includes(MARKER)).join('\n'));
  }
  if (core.isActive(root)) core.swapOut(root);
}

// Git repos that `base` is in or holds (sub-repos, two levels down).
function reposIn(base) {
  return isRepo(base) ? [base] : core.nestedRoots(base, { depth: 2, marker: '.git' });
}

// Set up a folder VS Code opened: itself if it's a repo, else every sub-repo plus hooks-only
// at the top. Returns { changed, repos }.
function enableTree(base, bin) {
  const repos = reposIn(base);
  const changed = repos.flatMap((r) => install(r, bin));
  if (repos.length && !repos.includes(base)) changed.push(...install(base, bin, { hooksOnly: true }));
  return { changed, repos };
}

function disableTree(base) {
  const repos = reposIn(base);
  repos.forEach(uninstall);
  if (!repos.includes(base)) uninstall(base);
  return repos;
}

module.exports = { install, uninstall, enableTree, disableTree, reposIn, isInstalled, isRepo };
