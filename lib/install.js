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

function isInstalled(root) {
  const hooks = readJson(settingsPath(root)).hooks || {};
  return Object.values(hooks).some((groups) => groups.some(isOurs));
}

// Returns the files it changed.
function install(root, bin) {
  const cmd = `node "${slash(bin)}"`;
  const changed = [];
  fs.mkdirSync(core.paths(root).files, { recursive: true });

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

  // .gitignore
  const gi = path.join(root, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/^\/?\.ghost\/?$/m.test(giText)) {
    writeIfChanged(gi, giText + (giText && !giText.endsWith('\n') ? '\n' : '') + '.ghost/\n');
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

module.exports = { install, uninstall, isInstalled, isRepo };
