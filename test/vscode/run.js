'use strict';
// node test/vscode/run.js: launches a throwaway VS Code (own profile, downloaded once into
// .vscode-test/) with this extension and runs the suites inside it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');

// Each suite gets a fresh workspace from its setup function.
const suites = [
  {
    file: 'suite.js',
    setup: (ws) => execSync('git init -q', { cwd: ws }),
  },
  {
    file: 'suite-subrepo.js', // plain parent folder holding a git repo, like projects/web-app
    setup: (ws) => {
      const sub = path.join(ws, 'console');
      fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
      execSync('git init -q', { cwd: sub });
      fs.writeFileSync(path.join(sub, 'src', 'badge.tsx'), 'const a = 1;\n');
    },
  },
];

(async () => {
  for (const s of suites) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-vscode-'));
    s.setup(ws);
    try {
      await runTests({
        extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
        extensionTestsPath: path.join(__dirname, s.file),
        launchArgs: [ws, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
        extensionTestsEnv: { VIBE_TEST_WS: ws },
      });
    } catch (e) {
      console.error(`VS Code tests failed (${s.file}):`, e.message || e);
      process.exitCode = 1;
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
})();
