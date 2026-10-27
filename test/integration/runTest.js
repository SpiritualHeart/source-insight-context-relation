'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const executable = process.env.VSCODE_EXECUTABLE
    || 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
  if (!fs.existsSync(executable)) {
    throw new Error(`VS Code executable not found: ${executable}`);
  }

  process.env.SOURCE_INSIGHT_TEST = '1';
  // DSH's shell runs with ELECTRON_RUN_AS_NODE=1, which would turn Code.exe
  // into a plain Node interpreter instead of the VS Code desktop app.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const exitCode = await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', 'integration', 'suite.js'),
    extensionTestsEnv: {
      SOURCE_INSIGHT_TEST: '1',
    },
    launchArgs: [
      path.join(root, 'test', 'integration', 'fixture'),
      '--disable-gpu',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--new-window',
    ],
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
