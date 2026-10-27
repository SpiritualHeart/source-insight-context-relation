'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');
const WebSocket = require('ws');

const NAME = 'APP_Model_Set29COutputs';
const VARIABLE = 'g_app_model_state';
const DEBUGGING_PORT = 9444;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = undefined;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
      this.socket.on('message', (payload) => {
        const message = JSON.parse(payload.toString());
        if (!message.id) {
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'CDP error'));
        } else {
          pending.resolve(message.result);
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

async function captureWorkbenchScreenshot(filePath) {
  const targets = await httpJson(`http://127.0.0.1:${DEBUGGING_PORT}/json/list`);
  const page = targets.find((target) => target.type === 'page' && /workbench/.test(target.url))
    || targets.find((target) => target.type === 'page');
  assert.ok(page, 'Expected a VS Code workbench page target');

  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1680,
      height: 920,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(2000);
    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
    console.log(`Screenshot written to ${filePath}`);
  } finally {
    client.close();
  }
}

async function evaluateWebview(expression) {
  const targets = await httpJson(`http://127.0.0.1:${DEBUGGING_PORT}/json/list`);
  const iframe = targets.find(
    (target) => target.type === 'iframe' && /purpose=webviewView/.test(target.url),
  );
  assert.ok(iframe, 'Expected the Source Insight webview frame');

  const client = new CdpClient(iframe.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    const result = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const frame = document.getElementById('active-frame');
        if (!frame || !frame.contentDocument) return '';
        const doc = frame.contentDocument;
        ${expression}
      })()`,
      returnByValue: true,
    });
    assert.ok(result.result && result.result.value, 'Webview DOM should be inspectable');
    return JSON.parse(result.result.value);
  } finally {
    client.close();
  }
}

async function inspectAndDoubleClickDeclaration() {
  return evaluateWebview(`
    const cards = [...doc.querySelectorAll('.node-card, .declaration-card')];
    const declaration = doc.querySelector('.declaration-card');
    const info = {
      emptyHidden: doc.querySelector('.empty-state')?.hidden,
      splitDisplay: getComputedStyle(doc.querySelector('.split')).display,
      cards: cards.length,
      declarationCards: doc.querySelectorAll('.declaration-card').length,
      chevrons: doc.querySelectorAll('.chevron').length,
      contextTitle: doc.querySelector('#context-title')?.textContent || '',
      contextHit: doc.querySelector('.code-line.is-target .symbol-hit')?.textContent || '',
      relationTitle: doc.querySelector('#relation-title')?.textContent || '',
      nodeText: cards.map((card) => card.innerText).join(' '),
      contextMenuVisible: !doc.querySelector('#node-menu').hidden
    };
    if (declaration) {
      declaration.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: frame.contentWindow
      }));
    }
    return JSON.stringify(info);
  `);
}

async function inspectBothLayout() {
  return evaluateWebview(`
    return JSON.stringify({
      leftCards: doc.querySelectorAll('.forest-col.is-left .node-card').length,
      rightCards: doc.querySelectorAll('.forest-col.is-right .node-card').length,
      tabs: doc.querySelectorAll('.relation-tab').length,
      rootTitle: doc.querySelector('#relation-title')?.textContent || ''
    });
  `);
}

async function switchGraphLayouts() {
  return evaluateWebview(`
    const tree = doc.querySelector('#tree');
    const click = (id) => doc.querySelector(id)?.click();
    click('#layout-vertical');
    const vertical = tree.className;
    click('#layout-outline');
    const outline = tree.className;
    click('#layout-horizontal');
    const horizontal = tree.className;
    return JSON.stringify({ vertical, outline, horizontal });
  `);
}

async function openCallerContextMenu() {
  return evaluateWebview(`
    const caller = doc.querySelector('.node-card.role-caller');
    if (!caller) return JSON.stringify({ error: 'no caller node' });
    const name = caller.querySelector('.node-name')?.textContent || '';
    const rect = caller.getBoundingClientRect();
    caller.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 18,
      clientY: rect.top + 12,
      view: frame.contentWindow
    }));
    const menu = doc.querySelector('#node-menu');
    const title = doc.querySelector('#node-menu-title')?.textContent || '';
    const visible = !menu.hidden;
    const action = menu.querySelector('[data-menu-action="showCallers"]');
    const actionExists = Boolean(action);
    action?.click();
    return JSON.stringify({ name, visible, title, actionExists });
  `);
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

async function getState() {
  return vscode.commands.executeCommand('sourceInsight.__getState');
}

async function waitForReadyState(timeoutMs) {
  const started = Date.now();
  let lastLog = 0;
  while (Date.now() - started < timeoutMs) {
    const payload = await getState();
    const state = payload && payload.state;
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      console.log(
        'function state:',
        JSON.stringify({
          status: state && state.status,
          error: state && state.error,
          context: state?.context?.symbolName,
          mode: state?.relation?.mode,
          right: state?.relation?.right?.map((node) => node.name),
          debug: payload?.debug,
          warnings: state?.relation?.warnings,
        }),
      );
    }
    if (
      state &&
      state.status === 'ready' &&
      state.context &&
      state.context.symbolName === NAME &&
      payload.debug &&
      payload.debug.definition.uri.endsWith('/APP_Model.c') &&
      payload.debug.declaration &&
      payload.debug.declaration.uri.endsWith('/APP_Model.h') &&
      state.relation &&
      state.relation.mode === 'callers' &&
      state.relation.declaration &&
      state.relation.right.length >= 2
    ) {
      return payload;
    }
    await delay(1200);
    await vscode.commands.executeCommand('sourceInsight.refresh');
  }
  throw new Error('Timed out waiting for C/C++ function relation analysis');
}

async function waitForCallerRoot(callerName, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await getState();
    if (
      payload?.state?.relation &&
      payload.state.relation.rootName === callerName &&
      payload.state.relation.mode === 'callers'
    ) {
      return payload;
    }
    await delay(300);
  }
  throw new Error('Timed out waiting for right-click Show Callers');
}

async function waitForVariableState(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await getState();
    const state = payload && payload.state;
    if (
      state &&
      state.status === 'ready' &&
      state.context &&
      state.context.symbolName === VARIABLE &&
      payload.debug &&
      payload.debug.definition.uri.endsWith('/APP_Model.c') &&
      payload.debug.declaration &&
      payload.debug.declaration.uri.endsWith('/APP_Model.h') &&
      state.relation &&
      state.relation.mode === 'references' &&
      state.relation.right.length >= 2
    ) {
      return payload;
    }
    await delay(1200);
    await vscode.commands.executeCommand('sourceInsight.refresh');
  }
  throw new Error('Timed out waiting for variable relation analysis');
}

function countNodeRefs(nodes) {
  let reads = 0;
  let writes = 0;
  for (const node of nodes) {
    reads += node.readCount || 0;
    writes += node.writeCount || 0;
    const nested = countNodeRefs(node.children || []);
    reads += nested.reads;
    writes += nested.writes;
  }
  return { reads, writes };
}

async function run() {
  const cpptools = vscode.extensions.getExtension('ms-vscode.cpptools');
  assert.ok(cpptools, 'C/C++ extension must be available in the isolated test host');
  await cpptools.activate();

  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(folder, 'Test workspace should be open');
  const pepUri = vscode.Uri.joinPath(folder.uri, 'APP_Model_PEP.c');
  const pepDocument = await vscode.workspace.openTextDocument(pepUri);
  const editor = await vscode.window.showTextDocument(pepDocument, {
    preview: false,
    preserveFocus: false,
  });

  await delay(3500);

  const callLine = pepDocument
    .getText()
    .split('\n')
    .findIndex((line) => line.includes(`${NAME}()`));
  assert.ok(callLine >= 0, 'Expected a call site in APP_Model_PEP.c');
  const character = pepDocument.lineAt(callLine).text.indexOf(NAME) + 2;
  const position = new vscode.Position(callLine, character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));

  await vscode.commands.executeCommand('sourceInsight.open');
  const payload = await waitForReadyState(30000);
  const state = payload.state;

  assert.equal(state.context.symbolName, NAME);
  assert.equal(state.context.isFunction, true);
  assert.equal(state.relation.mode, 'callers', 'Function default relation should be callers');
  assert.ok(state.relation.declaration, 'Relation must include declaration');
  assert.ok(state.relation.right.length >= 2, 'Expected at least two caller nodes');
  assert.ok(state.relation.counts.callers >= 2, 'Callers should be classified');
  assert.ok(state.context.lines.length >= 5, 'Context should include the definition body');
  assert.ok(
    state.relation.right.some((node) => node.name === 'APP_Model_SetPEPsOutputs'),
    'Expected caller APP_Model_SetPEPsOutputs',
  );
  assert.ok(
    state.relation.right.some((node) => node.name === 'APP_Model_Task10ms'),
    'Expected caller APP_Model_Task10ms',
  );

  await vscode.commands.executeCommand('sourceInsight.relationCallees');
  const calleeState = await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.mode === 'callees'
        && current.state.relation.right.length >= 2
        ? current
        : undefined;
    },
    15000,
    'callee relation mode',
  );
  assert.ok(
    calleeState.state.relation.right.some((node) => node.name === 'APP_Model_ReadOutput'),
    'Expected callee APP_Model_ReadOutput',
  );

  await vscode.commands.executeCommand('sourceInsight.relationBoth');
  const bothState = await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.mode === 'both'
        && current.state.relation.left.length >= 2
        && current.state.relation.right.length >= 2
        ? current
        : undefined;
    },
    15000,
    'both relation mode',
  );
  assert.ok(bothState.state.relation.left.length >= 2, 'Both mode should show callers on the left');
  assert.ok(bothState.state.relation.right.length >= 2, 'Both mode should show callees on the right');

  await vscode.commands.executeCommand('sourceInsight.relationCallers');
  await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.mode === 'callers';
    },
    10000,
    'restore caller mode',
  );

  await vscode.commands.executeCommand('sourceInsight.newRelationWindow');
  await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.tabs?.length === 2
        && current.state.relation.tabs.some((tab) => tab.active)
        ? current
        : undefined;
    },
    10000,
    'new relation tab',
  );
  await vscode.commands.executeCommand('sourceInsight.relationCallees');
  await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.mode === 'callees';
    },
    10000,
    'callee mode in new tab',
  );
  await vscode.commands.executeCommand('sourceInsight.closeRelationWindow');
  await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.tabs?.length === 1
        && current.state.relation.mode === 'callers'
        ? current
        : undefined;
    },
    10000,
    'close relation tab',
  );

  try {
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
  } catch {
    // The auxiliary bar (Chat) is optional in some VS Code builds.
  }
  await vscode.commands.executeCommand('workbench.action.focusPanel');
  await vscode.commands.executeCommand('sourceInsight.contextRelation.focus');
  await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
  await delay(2500);

  const rootDir = path.resolve(__dirname, '..', '..');
  const screenshotPath = path.join(rootDir, '.preview', 'vscode-real.png');
  await captureWorkbenchScreenshot(screenshotPath);
  fs.copyFileSync(screenshotPath, path.join(rootDir, 'media', 'preview.png'));

  await vscode.commands.executeCommand('sourceInsight.relationBoth');
  await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.mode === 'both';
    },
    10000,
    'both mode for UI check',
  );
  await delay(500);
  const bothDom = await inspectBothLayout();
  assert.ok(bothDom.leftCards >= 2, 'Both UI should render caller cards on the left');
  assert.ok(bothDom.rightCards >= 2, 'Both UI should render callee cards on the right');
  assert.equal(bothDom.tabs, 1, 'Relation tab strip should show the active view');
  assert.equal(bothDom.rootTitle, NAME);
  await vscode.commands.executeCommand('sourceInsight.relationCallers');
  await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.mode === 'callers';
    },
    10000,
    'restore caller mode for UI tests',
  );

  const layouts = await switchGraphLayouts();
  assert.match(layouts.vertical, /vertical-layout/, 'Vertical layout should render');
  assert.match(layouts.outline, /outline-layout/, 'Outline layout should render');
  assert.match(layouts.horizontal, /horizontal-layout/, 'Horizontal layout should restore');

  const dom = await inspectAndDoubleClickDeclaration();
  assert.equal(dom.emptyHidden, true, 'Empty state should be hidden after analysis');
  assert.equal(dom.splitDisplay, 'grid', 'Context / Relation panes should be visible');
  assert.ok(dom.cards >= 3, 'Relation should render its declaration and caller cards');
  assert.equal(dom.declarationCards, 1, 'Function tree should contain a declaration card');
  assert.ok(dom.chevrons >= 2, 'Caller nodes should expose expansion controls');
  assert.equal(dom.contextTitle, NAME, 'Context title should show only the symbol');
  assert.equal(dom.contextHit, NAME, 'Context code should highlight the target symbol name');
  assert.equal(dom.relationTitle, NAME, 'Relation title should show only the symbol');
  assert.doesNotMatch(dom.nodeText, /APP_Model\.(c|h):\d+/, 'Cards must not show file locations');
  assert.doesNotMatch(dom.contextTitle, /\.(c|h):\d+/, 'Context header must not show file locations');

  await waitFor(
    async () => {
      const active = vscode.window.activeTextEditor;
      return Boolean(active && active.document.uri.fsPath.endsWith('APP_Model.h'));
    },
    6000,
    'declaration double-click navigation',
  );

  const menu = await openCallerContextMenu();
  assert.ok(menu.name, 'Expected a caller node');
  assert.equal(menu.visible, true, 'Right-click menu should be visible');
  assert.equal(menu.title, menu.name, 'Menu title should be the caller symbol');
  assert.equal(menu.actionExists, true, 'Caller menu should include Show Callers');
  const callerState = await waitForCallerRoot(menu.name, 12000);
  assert.equal(callerState.state.relation.rootName, menu.name);

  const variableLine = pepDocument
    .getText()
    .split('\n')
    .findIndex((line) => line.includes(`${VARIABLE} = 1u;`));
  assert.ok(variableLine >= 0, 'Expected a variable write in APP_Model_PEP.c');
  const variableEditor = await vscode.window.showTextDocument(pepDocument, {
    preview: false,
    preserveFocus: false,
  });
  const variableCharacter = pepDocument.lineAt(variableLine).text.indexOf(VARIABLE) + 2;
  const variablePosition = new vscode.Position(variableLine, variableCharacter);
  variableEditor.selection = new vscode.Selection(variablePosition, variablePosition);
  variableEditor.revealRange(new vscode.Range(variablePosition, variablePosition));

  await vscode.commands.executeCommand('sourceInsight.open');
  const variablePayload = await waitForVariableState(20000);
  const variableState = variablePayload.state;
  assert.equal(variableState.context.isFunction, false);
  assert.equal(variableState.relation.mode, 'references');
  assert.equal(variableState.relation.rootName, VARIABLE);
  assert.ok(variableState.relation.declaration, 'Variable relation should include extern declaration');
  assert.ok(variablePayload.debug.declaration.uri.endsWith('/APP_Model.h'));
  assert.ok(variableState.relation.right.length >= 2);
  const refCounts = countNodeRefs(variableState.relation.right);
  assert.ok(refCounts.writes >= 1, 'Expected at least one write reference');
  assert.ok(refCounts.reads >= 1, 'Expected at least one read reference');

  const variableHit = await evaluateWebview(`
    return JSON.stringify({
      hit: doc.querySelector('.code-line.is-target .symbol-hit')?.textContent || '',
      title: doc.querySelector('#context-title')?.textContent || ''
    });
  `);
  assert.equal(variableHit.title, VARIABLE);
  assert.equal(variableHit.hit, VARIABLE, 'Variable definition should be highlighted in Context');

  await vscode.commands.executeCommand('sourceInsight.increaseDepth');
  await waitFor(
    async () => {
      const payload = await getState();
      return payload?.state?.relation?.depth === 2;
    },
    8000,
    'relation depth increase',
  );
  const depthState = await getState();
  assert.equal(depthState.state.relation.depth, 2, 'Depth command should increase depth');

  const taskUri = vscode.Uri.joinPath(folder.uri, 'APP_Model_Task.c');
  const taskDocument = await vscode.workspace.openTextDocument(taskUri);
  const taskEditor = await vscode.window.showTextDocument(taskDocument, {
    preview: false,
    preserveFocus: false,
  });
  const modelLine = taskDocument
    .getText()
    .split('\n')
    .findIndex((line) => line.includes('g_app_model.state ='));
  assert.ok(modelLine >= 0, 'Expected g_app_model usage in APP_Model_Task.c');
  const modelCharacter = taskDocument.lineAt(modelLine).text.indexOf('g_app_model') + 2;
  const modelPosition = new vscode.Position(modelLine, modelCharacter);
  taskEditor.selection = new vscode.Selection(modelPosition, modelPosition);
  taskEditor.revealRange(new vscode.Range(modelPosition, modelPosition));

  await vscode.commands.executeCommand('sourceInsight.open');
  const modelPayload = await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.context?.symbolName === 'g_app_model'
        && current.state.relation
        ? current
        : undefined;
    },
    20000,
    'struct variable context',
  );
  assert.ok(
    modelPayload.state.context.availableViews.includes('type'),
    'Variable Context should expose the type view',
  );
  assert.equal(modelPayload.state.context.typeName, 'APP_ModelState_t');

  await vscode.commands.executeCommand('sourceInsight.relationType');
  const typeState = await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.relation?.mode === 'type'
        && current.state.relation.right[0]?.children?.length >= 2
        ? current
        : undefined;
    },
    15000,
    'variable type relation',
  );
  assert.equal(typeState.state.relation.right[0].role, 'type');
  assert.ok(
    typeState.state.relation.right[0].children.some((node) => node.name === 'state'),
    'Type relation should include struct member state',
  );

  const headerUri = vscode.Uri.joinPath(folder.uri, 'APP_Model.h');
  const headerDocument = await vscode.workspace.openTextDocument(headerUri);
  const headerEditor = await vscode.window.showTextDocument(headerDocument, {
    preview: false,
    preserveFocus: false,
  });
  const typeLine = headerDocument
    .getText()
    .split('\n')
    .findIndex((line) => line.includes('} APP_ModelState_t;'));
  assert.ok(typeLine >= 0, 'Expected struct typedef in APP_Model.h');
  const typeCharacter = headerDocument.lineAt(typeLine).text.indexOf('APP_ModelState_t') + 2;
  const typePosition = new vscode.Position(typeLine, typeCharacter);
  headerEditor.selection = new vscode.Selection(typePosition, typePosition);
  headerEditor.revealRange(new vscode.Range(typePosition, typePosition));

  await vscode.commands.executeCommand('sourceInsight.open');
  const containsState = await waitFor(
    async () => {
      const current = await getState();
      return current?.state?.context?.symbolName === 'APP_ModelState_t'
        && current.state.relation?.mode === 'contains'
        && current.state.relation.right.some((node) => node.name === 'state')
        ? current
        : undefined;
    },
    20000,
    'struct contains relation',
  );
  assert.ok(
    containsState.state.relation.right.some((node) => node.name === 'enabled'),
    'Contains relation should include struct member enabled',
  );

  console.log(
    `C/C++ integration OK: callers=${state.relation.right.length}, root=${state.relation.rootName}, menuCaller=${menu.name}, variableRefs=${variableState.relation.right.length} (${refCounts.reads} read / ${refCounts.writes} write), depth=${depthState.state.relation.depth}, type=${typeState.state.relation.right[0].name}, members=${containsState.state.relation.right.length}`,
  );
}

exports.run = run;
