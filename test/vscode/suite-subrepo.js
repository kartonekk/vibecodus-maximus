'use strict';
// VS Code opened on a plain parent folder holding a sub-repo (like projects/web-app).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const core = require('../../lib/core');

const ws = process.env.VIBE_TEST_WS;
const sub = path.join(ws, 'console');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

async function test(name, fn) {
  await fn();
  console.log(`ok  [sub-repo] ${name}`);
}

exports.run = async () => {
  const api = await vscode.extensions.getExtension('karton.vibecodus-maximus').activate();
  const file = path.join(sub, 'src', 'badge.tsx');

  await test('auto-enable: full setup in the sub-repo, hooks-only in the parent', async () => {
    const subSettings = path.join(sub, '.claude', 'settings.local.json');
    assert.ok(await waitFor(() => fs.existsSync(subSettings)), 'sub-repo hooks');
    assert.ok(fs.existsSync(path.join(ws, '.claude', 'settings.local.json')), 'parent hooks (claude started in the parent)');
    assert.match(fs.readFileSync(path.join(sub, '.gitignore'), 'utf8'), /\.ghost\//);
    assert.ok(!fs.existsSync(path.join(ws, '.gitignore')), 'parent is not a repo: no .gitignore there');
  });

  await test('draft in the sub-repo shows as ghost text and a badge', async () => {
    const gp = core.ghostFile(sub, 'src/badge.tsx');
    fs.mkdirSync(path.dirname(gp), { recursive: true });
    fs.writeFileSync(gp, 'const a = 1;\nconst added = true;\n');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    // the new draft line pairs with the file's empty last line: the ghost sits there
    const at = new vscode.Position(1, 0);
    editor.selection = new vscode.Selection(at, at);
    const items = api.inlineGhost.provideInlineCompletionItems(doc, at);
    assert.ok(items && items[0].insertText === 'const added = true;', `ghost text: ${JSON.stringify(items && items[0].insertText)}`);
    const d = api.fileBadges.provideFileDecoration(vscode.Uri.file(file));
    assert.ok(d && d.badge === '👻', 'badge');
  });

  await test('repo folder in the parent gets a count badge, even collapsed', async () => {
    await sleep(300); // let the .ghost watcher reset the repo list
    const folder = api.fileBadges.provideFileDecoration(vscode.Uri.file(sub));
    assert.ok(folder && folder.badge === '1', `folder badge: ${folder && folder.badge}`);
    assert.match(folder.tooltip, /1 unfinished file\(s\) in here:\n  src\/badge\.tsx/);
    // and every folder in between
    const src = api.fileBadges.provideFileDecoration(vscode.Uri.file(path.join(sub, 'src')));
    assert.ok(src && src.badge === '1', `src badge: ${src && src.badge}`);
    assert.match(src.tooltip, /\n  badge\.tsx/);
    fs.mkdirSync(path.join(sub, 'docs'), { recursive: true });
    assert.strictEqual(api.fileBadges.provideFileDecoration(vscode.Uri.file(path.join(sub, 'docs'))), undefined, 'folder without drafts');
    // the draft file is announced explicitly, so VS Code decorates (and tints parents) without rendering it
    const announced = api.announceDecorations().map((u) => u.fsPath.toLowerCase());
    assert.ok(announced.includes(file.toLowerCase()), 'draft file announced');
    assert.ok(announced.includes(sub.toLowerCase()), 'repo folder announced');
    assert.ok(announced.includes(path.join(sub, 'src').toLowerCase()), 'folders in between announced');
    assert.strictEqual(api.fileBadges.provideFileDecoration(vscode.Uri.file(ws)), undefined, 'plain parent: no badge of its own');
  });

  await test('Ghost Code view shows the sub-repo draft under its folders', async () => {
    const top = api.ghostTree.getChildren();
    assert.deepStrictEqual(top.map((n) => api.ghostTree.getTreeItem(n).label), ['console/src'], 'repo folder + src in one row');
    const [f] = api.ghostTree.getChildren(top[0]);
    assert.strictEqual(f.fsPath.toLowerCase(), file.toLowerCase());
    assert.ok(!api.ghostTree.getChildren(top[0]).some((n) => n.kind === 'folder'), 'empty docs/ folder not shown');
  });
};
