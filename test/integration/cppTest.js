'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

function linkDirectory(source, destination) {
  if (fs.existsSync(destination)) {
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination, 'junction');
}

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const executable = process.env.VSCODE_EXECUTABLE
    || 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
  if (!fs.existsSync(executable)) {
    throw new Error(`VS Code executable not found: ${executable}`);
  }

  const machineExtensions = path.join(process.env.USERPROFILE || '', '.vscode', 'extensions');
  const cpptools = fs
    .readdirSync(machineExtensions)
    .find((entry) => /^ms-vscode\.cpptools-\d/.test(entry));
  if (!cpptools) {
    throw new Error('Install ms-vscode.cpptools before running the C/C++ integration test');
  }

  const previewRoot = path.join(root, '.preview');
  const extensionsDir = path.join(previewRoot, 'test-extensions');
  const profileDir = path.join(previewRoot, `test-profile-${Date.now()}`);
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  linkDirectory(path.join(machineExtensions, cpptools), path.join(extensionsDir, cpptools));

  process.env.SOURCE_INSIGHT_TEST = '1';
  delete process.env.ELECTRON_RUN_AS_NODE;

  const exitCode = await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', 'integration', 'cpp-suite.js'),
    extensionTestsEnv: {
      SOURCE_INSIGHT_TEST: '1',
    },
    launchArgs: [
      path.join(root, 'test', 'cpp-demo'),
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=9444',
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
