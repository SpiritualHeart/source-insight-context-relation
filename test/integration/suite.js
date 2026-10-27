'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

const SCHEME = 'source-insight-test';
const NAME = 'APP_Model_Set29COutputs';

const headerUri = vscode.Uri.parse(`${SCHEME}:/demo/APP_Model.h`);
const sourceUri = vscode.Uri.parse(`${SCHEME}:/demo/APP_Model.c`);
const pepUri = vscode.Uri.parse(`${SCHEME}:/demo/APP_Model_PEP.c`);
const taskUri = vscode.Uri.parse(`${SCHEME}:/demo/APP_Model_Task.c`);

const documents = new Map([
  [
    headerUri.toString(),
    [
      '#ifndef APP_MODEL_H',
      '#define APP_MODEL_H',
      '',
      'void APP_Model_Set29COutputs(void);',
      'void APP_Model_SetPEPsOutputs(void);',
      'void APP_Model_Task10ms(void);',
      '',
      '#endif',
    ].join('\n'),
  ],
  [
    sourceUri.toString(),
    [
      '#include "APP_Model.h"',
      '',
      'static unsigned char s_state = 0u;',
      '',
      'void APP_Model_Set29COutputs(void)',
      '{',
      '    unsigned char temp = s_state;',
      '    s_state = temp;',
      '}',
    ].join('\n'),
  ],
  [
    pepUri.toString(),
    [
      '#include "APP_Model.h"',
      '',
      'void APP_Model_SetPEPsOutputs(void)',
      '{',
      '    APP_Model_Set29COutputs();',
      '}',
    ].join('\n'),
  ],
  [
    taskUri.toString(),
    [
      '#include "APP_Model.h"',
      '',
      'void APP_Model_Task10ms(void)',
      '{',
      '    if (s_enable) {',
      '        APP_Model_Set29COutputs();',
      '    }',
      '}',
    ].join('\n'),
  ],
]);

const callLocations = [
  makeLocation(headerUri, 3, 5, 29),
  makeLocation(pepUri, 4, 4, 28),
  makeLocation(taskUri, 5, 8, 32),
];

function makeLocation(uri, line, startChar, endChar) {
  return new vscode.Location(
    uri,
    new vscode.Range(line, startChar, line, endChar),
  );
}

function makeSymbol(name, uri, startLine, endLine, nameStart, nameEnd) {
  const fullRange = new vscode.Range(
    startLine,
    0,
    endLine,
    startLine === endLine ? Math.max(80, nameEnd + 1) : 1,
  );
  return new vscode.DocumentSymbol(
    name,
    '',
    vscode.SymbolKind.Function,
    fullRange,
    new vscode.Range(startLine, nameStart, startLine, nameEnd),
  );
}

function registerTestLanguageFeatures() {
  const disposables = [];

  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent(uri) {
        return documents.get(uri.toString()) || '';
      },
    }),
  );

  disposables.push(
    vscode.languages.registerDefinitionProvider(
      { scheme: SCHEME },
      {
        provideDefinition(document, position) {
          const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
          if (!range || document.getText(range) !== NAME) {
            return undefined;
          }
          // Simulate cpptools occasionally answering a definition-site query
          // with the matching header prototype. The extension must still use
          // the current source definition.
          if (document.uri.toString() === sourceUri.toString() && position.line === 4) {
            return new vscode.Location(headerUri, new vscode.Range(3, 5, 3, 29));
          }
          return new vscode.Location(sourceUri, new vscode.Range(4, 5, 4, 29));
        },
      },
    ),
  );

  disposables.push(
    vscode.languages.registerDeclarationProvider(
      { scheme: SCHEME },
      {
        provideDeclaration(document, position) {
          const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
          if (!range || document.getText(range) !== NAME) {
            return undefined;
          }
          return new vscode.Location(headerUri, new vscode.Range(3, 5, 3, 29));
        },
      },
    ),
  );

  disposables.push(
    vscode.languages.registerReferenceProvider(
      { scheme: SCHEME },
      {
        provideReferences(document, position, context) {
          const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
          if (!range || document.getText(range) !== NAME) {
            return [];
          }
          return callLocations;
        },
      },
    ),
  );

  disposables.push(
    vscode.languages.registerDocumentSymbolProvider(
      { scheme: SCHEME },
      {
        provideDocumentSymbols(document) {
          const key = document.uri.toString();
          if (key === sourceUri.toString()) {
            return [makeSymbol(NAME, sourceUri, 4, 8, 5, 29)];
          }
          if (key === pepUri.toString()) {
            return [makeSymbol('APP_Model_SetPEPsOutputs', pepUri, 2, 5, 5, 28)];
          }
          if (key === taskUri.toString()) {
            return [makeSymbol('APP_Model_Task10ms', taskUri, 2, 7, 5, 24)];
          }
          if (key === headerUri.toString()) {
            return [
              makeSymbol(NAME, headerUri, 3, 3, 5, 29),
              makeSymbol('APP_Model_SetPEPsOutputs', headerUri, 4, 4, 5, 28),
              makeSymbol('APP_Model_Task10ms', headerUri, 5, 5, 5, 24),
            ];
          }
          return [];
        },
      },
    ),
  );

  return disposables;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  const disposables = registerTestLanguageFeatures();
  try {
    const extension = vscode.extensions.getExtension(
      'onepiece-tools.source-insight-context-relation',
    );
    assert.ok(extension, 'Extension should be discoverable in the test host');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'sourceInsight.open',
      'sourceInsight.refresh',
      'sourceInsight.toggleFollow',
      'sourceInsight.goToDefinition',
      'sourceInsight.clear',
      'sourceInsight.relationCallers',
      'sourceInsight.relationCallees',
      'sourceInsight.relationBoth',
      'sourceInsight.increaseDepth',
      'sourceInsight.decreaseDepth',
      'sourceInsight.toggleContextLock',
      'sourceInsight.toggleRelationLock',
      'sourceInsight.openUserGuide',
      'sourceInsight.__getState',
    ]) {
      assert.ok(commands.includes(command), `Command ${command} should be registered`);
    }

    const pepDocument = await vscode.workspace.openTextDocument(pepUri);
    const editor = await vscode.window.showTextDocument(pepDocument, {
      preview: false,
      preserveFocus: false,
    });
    const callLine = pepDocument
      .getText()
      .split('\n')
      .findIndex((line) => line.includes(`${NAME}()`));
    assert.ok(callLine >= 0, 'Call line should exist');
    const callCharacter = pepDocument.lineAt(callLine).text.indexOf(NAME) + 2;
    const position = new vscode.Position(callLine, callCharacter);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));

    await vscode.commands.executeCommand('sourceInsight.open');

    const payload = await waitFor(
      async () => {
        const current = await vscode.commands.executeCommand('sourceInsight.__getState');
        if (!current || !current.state) {
          return undefined;
        }
        if (current.state.status === 'ready' && current.state.relation) {
          return current;
        }
        return undefined;
      },
      12000,
      'Source Insight analysis',
    );

    const state = payload.state;
    assert.equal(state.context.symbolName, NAME);
    assert.equal(state.context.isFunction, true);
    assert.ok(payload.debug, 'Test debug payload should be present');
    assert.equal(payload.debug.name, NAME);
    assert.equal(payload.debug.definition.uri, sourceUri.toString(), 'Definition should be the .c body');
    assert.equal(payload.debug.declaration.uri, headerUri.toString(), 'Declaration should be the .h prototype');
    assert.ok(state.relation, 'Relation should be present');
    assert.equal(state.relation.mode, 'callers', 'Functions should default to callers');
    assert.ok(state.relation.declaration, 'Function relation must include a declaration node');
    assert.equal(state.relation.declaration.role, 'declaration');
    assert.ok(
      state.relation.right.length >= 2,
      `Expected at least 2 caller nodes, got ${state.relation.right.length}`,
    );
    assert.equal(state.relation.root.role, 'definition');
    assert.equal(state.relation.isFunction, true);
    assert.ok(state.relation.counts.callers >= 2, 'Callers should be classified');
    assert.equal(state.context.targetStartLine, 4);
    assert.ok(state.context.lines.length >= 5, 'Context should include the function body');
    assert.equal(state.context.lines[0].line, 3, 'Context should start one line before the definition');

    const referencesByLabel = new Map(
      state.relation.right.map((reference) => [reference.name, reference]),
    );
    assert.ok(referencesByLabel.has('APP_Model_SetPEPsOutputs'));
    assert.ok(referencesByLabel.has('APP_Model_Task10ms'));

    await vscode.commands.executeCommand('sourceInsight.increaseDepth');
    const deeper = await vscode.commands.executeCommand('sourceInsight.__getState');
    assert.equal(deeper.state.relation.depth, 2, 'Depth command should increase relation depth');

    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    const sourceEditor = await vscode.window.showTextDocument(sourceDocument, {
      preview: false,
      preserveFocus: false,
    });
    const sourcePosition = new vscode.Position(4, 7);
    sourceEditor.selection = new vscode.Selection(sourcePosition, sourcePosition);
    sourceEditor.revealRange(new vscode.Range(sourcePosition, sourcePosition));
    await vscode.commands.executeCommand('sourceInsight.open');
    const definitionSiteState = await waitFor(
      async () => {
        const current = await vscode.commands.executeCommand('sourceInsight.__getState');
        return current?.state?.status === 'ready'
          && current.state.context?.symbolName === NAME
          && current.debug?.definition?.uri === sourceUri.toString()
          ? current
          : undefined;
      },
      12000,
      'source definition-site context',
    );
    assert.equal(
      definitionSiteState.state.context.targetStartLine,
      4,
      'Clicking the source definition must show the source definition, not the header prototype',
    );

    await vscode.commands.executeCommand('sourceInsight.clear');
    const cleared = await vscode.commands.executeCommand('sourceInsight.__getState');
    assert.equal(cleared.state.status, 'empty');
    assert.equal(cleared.hasSnapshot, false);

    await vscode.commands.executeCommand('sourceInsight.openUserGuide');
    await delay(300);

    console.log(
      `Integration OK: definition=${payload.debug.definition.uri}, declaration=${payload.debug.declaration.uri}, callers=${state.relation.right.length}, depth=${deeper.state.relation.depth}`,
    );
  } finally {
    for (const disposable of disposables.reverse()) {
      disposable.dispose();
    }
  }
}

exports.run = run;
