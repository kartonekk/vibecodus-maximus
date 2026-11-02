'use strict';
// Runs inside a real VS Code. Plain asserts, no test framework.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const core = require('../../lib/core');

const ws = process.env.VIBE_TEST_WS;
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
  console.log(`ok  ${name}`);
}

exports.run = async () => {
  const ext = vscode.extensions.getExtension('karton.vibecodus-maximus');
  const api = await ext.activate();
  const file = path.join(ws, 'app.ts');
  const mine = 'const x = 1;\nconst z = 3;\n';
  const draft = 'const x = 1;\nconst y = 2;\nconst w = 4;\nconst z = 3;\n';

  await test('auto-enable wired the git repo', async () => {
    assert.ok(await waitFor(() => fs.existsSync(path.join(ws, '.claude', 'settings.local.json'))), 'hooks written');
  });

  await test('restored file reloads in the editor (no Claude code left on screen)', async () => {
    // During a Claude turn the editor shows Claude's version...
    fs.writeFileSync(file, draft);
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(doc.getText(), draft);
    // ...then the Stop hook restores the user's file and parks the draft.
    fs.mkdirSync(path.dirname(core.ghostFile(ws, 'app.ts')), { recursive: true });
    fs.writeFileSync(core.ghostFile(ws, 'app.ts'), draft);
    fs.writeFileSync(path.join(ws, 'snap.tmp'), mine);
    const old = new Date('2020-01-01');
    fs.utimesSync(path.join(ws, 'snap.tmp'), old, old);
    require('../../lib/core'); // same copy the hook uses
    const copy = (from, to) => fs.writeFileSync(to, fs.readFileSync(from)); // mirrors core.copyFile
    copy(path.join(ws, 'snap.tmp'), file);
    assert.ok(await waitFor(() => doc.getText() === mine), `editor kept Claude's version: ${JSON.stringify(doc.getText())}`);
  });

  await test('observation: does VS Code reload a restore that keeps an older mtime?', async () => {
    const other = path.join(ws, 'other.ts');
    fs.writeFileSync(other, draft);
    const doc = await vscode.workspace.openTextDocument(other);
    await vscode.window.showTextDocument(doc);
    fs.copyFileSync(path.join(ws, 'snap.tmp'), other); // keeps the 2020 mtime on Windows
    const reloaded = await waitFor(() => doc.getText() === mine, 3000);
    console.log(`    (copyFileSync restore ${reloaded ? 'did' : 'did NOT'} reload)`);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  await test('inline ghost text: lines below, at the cursor', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    const end = doc.lineAt(0).range.end;
    editor.selection = new vscode.Selection(end, end);
    const items = api.inlineGhost.provideInlineCompletionItems(doc, end);
    assert.ok(items && items.length === 1, 'one item');
    assert.strictEqual(items[0].insertText, '\nconst y = 2;\nconst w = 4;');
  });

  await test('typing over the ghost: remainder follows the typed prefix', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => b.insert(doc.lineAt(0).range.end, '\nconst y'));
    const pos = doc.lineAt(1).range.end;
    editor.selection = new vscode.Selection(pos, pos);
    const items = api.inlineGhost.provideInlineCompletionItems(doc, pos);
    assert.strictEqual(items[0].insertText, ' = 2;\nconst w = 4;');
  });

  await test('auto-closed quote: ghost fills the gap and keeps the quote after it', async () => {
    const qfile = path.join(ws, 'quote.ts');
    fs.writeFileSync(qfile, 'const s = "hello";\n'); // you typed `"hello`, VS Code added the closing `"`
    fs.writeFileSync(core.ghostFile(ws, 'quote.ts'), 'const s = "hello world";\n');
    const doc = await vscode.workspace.openTextDocument(qfile);
    await vscode.window.showTextDocument(doc);
    const at = new vscode.Position(0, 16); // right before the closing quote
    const [item] = api.inlineGhost.provideInlineCompletionItems(doc, at);
    assert.strictEqual(item.insertText, ' world";');
    assert.ok(item.range.start.isEqual(at) && item.range.end.isEqual(doc.lineAt(0).range.end), 'replaces up to the line end');
    assert.strictEqual(api.inlineGhost.provideInlineCompletionItems(doc, new vscode.Position(0, 5)), undefined, 'not mid-word');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  await test('unfinished file gets a 👻 badge; fully typed file loses it', async () => {
    const uri = vscode.Uri.file(file);
    const d = api.fileBadges.provideFileDecoration(uri);
    assert.ok(d && d.badge === '👻' && d.propagate, 'badge on unfinished file');
    assert.match(d.tooltip, /\d+ of \d+ draft lines left/);
    assert.strictEqual(api.fileBadges.provideFileDecoration(vscode.Uri.file(path.join(ws, 'snap.tmp'))), undefined, 'no draft, no badge');
    // Claude mid-turn: ✍ on the files in the active manifest
    const active = path.join(ws, '.ghost', 'active.json');
    fs.writeFileSync(active, JSON.stringify({ files: { 'app.ts': { existed: true } } }));
    assert.strictEqual(api.fileBadges.provideFileDecoration(uri).badge, '✍');
    fs.rmSync(active);
  });

  await test('focus mode: other autocomplete off in the draft file, restored when you leave', async () => {
    const cfg = () => vscode.workspace.getConfiguration();
    const g = () => cfg().inspect('editor.quickSuggestions').globalValue;
    // start outside focus mode (earlier tests had the draft open)
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(ws, 'snap.tmp')));
    await sleep(400);
    await api.settleFocus();
    // a value the user set themselves must come back exactly
    await cfg().update('editor.suggestOnTriggerCharacters', true, vscode.ConfigurationTarget.Global);
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await sleep(400);
    await api.settleFocus();
    assert.deepStrictEqual(g(), { other: 'off', comments: 'off', strings: 'off' }, 'quick suggestions off');
    assert.strictEqual(cfg().inspect('editor.suggestOnTriggerCharacters').globalValue, false);
    assert.strictEqual(cfg().inspect('editor.wordBasedSuggestions').globalValue, 'off');

    const plain = await vscode.workspace.openTextDocument(path.join(ws, 'snap.tmp'));
    await vscode.window.showTextDocument(plain);
    await sleep(400);
    await api.settleFocus();
    assert.strictEqual(g(), undefined, 'unset setting removed again, not pinned');
    assert.strictEqual(cfg().inspect('editor.suggestOnTriggerCharacters').globalValue, true, 'user value restored');

    // a change you make while in the draft file is kept, not overwritten on leave
    await vscode.window.showTextDocument(doc);
    await sleep(400);
    await api.settleFocus();
    await cfg().update('editor.wordBasedSuggestions', 'allDocuments', vscode.ConfigurationTarget.Global);
    await vscode.window.showTextDocument(plain);
    await sleep(400);
    await api.settleFocus();
    assert.strictEqual(cfg().inspect('editor.wordBasedSuggestions').globalValue, 'allDocuments', 'your change kept');
    assert.strictEqual(g(), undefined);

    await vscode.window.showTextDocument(doc); // back to the draft for the next tests
    await sleep(400);
    await api.settleFocus();
  });

  await test('Tab fills a whole comment line, but only indents on a code line', async () => {
    const cfile = path.join(ws, 'comment.ts');
    const long = '/** This explains what b is for, in some detail. */'; // > paste-guard threshold
    fs.writeFileSync(cfile, 'const a = 1;\n');
    fs.writeFileSync(core.ghostFile(ws, 'comment.ts'), `const a = 1;\n${long}\nconst b = 2;\n`);
    const doc = await vscode.workspace.openTextDocument(cfile);
    const editor = await vscode.window.showTextDocument(doc);
    let at = new vscode.Position(1, 0);
    editor.selection = new vscode.Selection(at, at);
    await vscode.commands.executeCommand('vibeGhost.noAccept');
    await sleep(300);
    assert.strictEqual(doc.lineAt(1).text, long, 'comment line filled in (and not undone by the paste guard)');
    await editor.edit((b) => b.insert(doc.lineAt(1).range.end, '\n'));
    at = doc.lineAt(2).range.end;
    editor.selection = new vscode.Selection(at, at);
    await vscode.commands.executeCommand('vibeGhost.noAccept');
    await sleep(300);
    assert.doesNotMatch(doc.lineAt(2).text, /const/, 'code is never filled in');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await test('Tab fills a Python docstring line', async () => {
    const pfile = path.join(ws, 'status.py');
    const doc1 = '    """Return the active deploy status, or None when nothing is running."""';
    fs.writeFileSync(pfile, 'def status():\n');
    fs.writeFileSync(core.ghostFile(ws, 'status.py'), `def status():\n${doc1}\n    return None\n`);
    const doc = await vscode.workspace.openTextDocument(pfile);
    const editor = await vscode.window.showTextDocument(doc);
    assert.strictEqual(doc.languageId, 'python');
    const at = new vscode.Position(1, 0);
    editor.selection = new vscode.Selection(at, at);
    await vscode.commands.executeCommand('vibeGhost.noAccept');
    await sleep(300);
    assert.strictEqual(doc.lineAt(1).text, doc1);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await test('Tab, Tab, Tab fills a whole JSDoc block (cursor follows), then stops at code', async () => {
    const jfile = path.join(ws, 'jsdoc.ts');
    const block = ['/**', ' * Status of the running deploy, from the pulse.', ' */'];
    fs.writeFileSync(jfile, 'const a = 1;\n');
    fs.writeFileSync(core.ghostFile(ws, 'jsdoc.ts'), ['const a = 1;', ...block, 'export const b = 2;', ''].join('\n'));
    const doc = await vscode.workspace.openTextDocument(jfile);
    const editor = await vscode.window.showTextDocument(doc);
    // cursor at the end of the line above the block, like after clicking there
    const start = doc.lineAt(0).range.end;
    editor.selection = new vscode.Selection(start, start);
    for (let i = 0; i < 3; i++) await vscode.commands.executeCommand('vibeGhost.noAccept');
    assert.deepStrictEqual([1, 2, 3].map((l) => doc.lineAt(l).text), block);
    await vscode.commands.executeCommand('vibeGhost.noAccept'); // code next: just an indent
    assert.doesNotMatch(doc.getText(), /export const b/);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await test('Tab swaps a comment line Claude edited for the draft\'s version', async () => {
    const efile = path.join(ws, 'edited.ts');
    fs.writeFileSync(efile, '/**\n * Old wording.\n */\nconst c = 3;\n');
    fs.writeFileSync(core.ghostFile(ws, 'edited.ts'), '/**\n * New wording, with the deploy status.\n */\nconst c = 3;\n');
    const doc = await vscode.workspace.openTextDocument(efile);
    const editor = await vscode.window.showTextDocument(doc);
    const end = doc.lineAt(1).range.end;
    editor.selection = new vscode.Selection(end, end);
    await vscode.commands.executeCommand('vibeGhost.noAccept');
    assert.strictEqual(doc.lineAt(1).text, ' * New wording, with the deploy status.');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await test('accepting the ghost gets undone', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    const before = doc.getText();
    const pos = doc.lineAt(1).range.end;
    editor.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    await sleep(800);
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    await sleep(800);
    assert.strictEqual(api.stats.rejected, 1, 'ghost text was really shown and accepted, then caught');
    assert.strictEqual(doc.getText(), before, 'accept was undone');
  });

  await test('typing the whole draft clears the badge', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    // pasting the draft in one go would be undone by the paste guard, so type it line by line
    await editor.edit((b) => b.delete(new vscode.Range(0, 0, doc.lineCount, 0)));
    for (const line of draft.split('\n').filter(Boolean)) {
      await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, line + '\n'));
    }
    await doc.save();
    assert.ok(await waitFor(() => !fs.existsSync(core.ghostFile(ws, 'app.ts'))), 'draft retired');
    assert.strictEqual(api.fileBadges.provideFileDecoration(vscode.Uri.file(file)), undefined);
  });
};
