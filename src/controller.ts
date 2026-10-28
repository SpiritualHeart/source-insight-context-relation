import * as vscode from 'vscode';
import type {
  ContextMatchView,
  ContextView,
  ContextViewKind,
  NodeAction,
  PanelState,
  RelationMode,
  RelationNodeView,
  RelationTabView,
  RelationView,
  SourceLocation,
  TrackingMode,
  WebviewMessage,
} from './protocol';
import type {
  ContextFocus,
  ContextHistoryEntry,
  HostContext,
  HostNode,
  HostRelationTree,
  HostSymbol,
  RelationHistoryEntry,
  WorkspaceAnalyzerConfig,
} from './internal';
import {
  availableModesFor,
  defaultModeFor,
  RelationBuilder,
} from './relationBuilder';
import {
  AnalysisCancelledError,
  NoDefinitionError,
  NoSymbolError,
  readConfig,
  SymbolService,
} from './symbolService';
import { getWebviewHtml } from './webview';
import { fileNameFromUri } from './core';

const VIEW_ID = 'sourceInsight.contextRelation';
const MAX_DEPTH = 6;
const WORD_PATTERN = /[\p{L}_$][\p{L}\p{N}_$]*/u;

interface ContextPaneState {
  context: HostContext;
  symbol: HostSymbol;
  view: ContextViewKind;
  matches: ContextMatchView[];
  matchSymbols: HostSymbol[];
  activeMatch: number;
  focus?: ContextFocus;
}

interface RelationTabState {
  id: string;
  mode: RelationMode;
  depth: number;
  tree?: HostRelationTree;
}

export class SourceInsightController implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private webviewReady = false;
  private viewVisible = false;
  private pendingFocus: 'context' | 'relation' | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private analysisRevision = 0;
  private lastAnalysisKey = '';
  private lastEditor: vscode.TextEditor | undefined;
  private suppressFollowUntil = 0;

  private followCursor: boolean;
  private autoReveal: boolean;
  private trackingMode: TrackingMode;
  private relationDepth: number;
  private relationMode: RelationMode = 'references';
  private contextLocked = false;
  private relationLocked = false;

  private rootSymbol: HostSymbol | undefined;
  private matches: ContextMatchView[] = [];
  private matchSymbols: HostSymbol[] = [];
  private contextState: ContextPaneState | undefined;
  private relationTree: HostRelationTree | undefined;
  private relationTabs: RelationTabState[] = [];
  private activeTabId = 'relation-1';
  private nextTabNumber = 2;
  private contextHistory: ContextHistoryEntry[] = [];
  private contextHistoryIndex = -1;
  private relationHistory: RelationHistoryEntry[] = [];
  private relationHistoryIndex = -1;

  private state: PanelState;
  private readonly service: SymbolService;
  private readonly builder: RelationBuilder;
  private readonly log: vscode.OutputChannel;
  private readonly statusContext: vscode.StatusBarItem;
  private readonly statusRelation: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    const configuration = vscode.workspace.getConfiguration('sourceInsight');
    this.followCursor = configuration.get<boolean>('followCursor') ?? true;
    this.autoReveal = configuration.get<boolean>('autoReveal') ?? false;
    this.trackingMode = readTrackingMode(configuration.get<string>('trackingMode'));
    this.relationDepth = clampDepth(configuration.get<number>('defaultDepth') ?? 1);
    this.relationTabs = [{
      id: this.activeTabId,
      mode: 'references',
      depth: this.relationDepth,
    }];

    this.log = vscode.window.createOutputChannel('Source Insight');
    this.service = new SymbolService(
      (message) => this.log.appendLine(`[${new Date().toISOString()}] ${message}`),
      readConfig,
    );
    this.builder = new RelationBuilder(this.service, readConfig);
    this.state = this.emptyState();

    this.statusContext = vscode.window.createStatusBarItem(
      'sourceInsight.context',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusContext.name = 'Source Insight Context';
    this.statusContext.command = 'sourceInsight.focusContext';
    this.statusContext.tooltip = 'Source Insight Context 窗口';
    this.statusContext.text = '$(symbol-method) Source Insight';
    this.statusContext.show();

    this.statusRelation = vscode.window.createStatusBarItem(
      'sourceInsight.relation',
      vscode.StatusBarAlignment.Right,
      99,
    );
    this.statusRelation.name = 'Source Insight Relation';
    this.statusRelation.command = 'sourceInsight.focusRelation';
    this.statusRelation.tooltip = 'Source Insight Relation 窗口';
    this.statusRelation.text = '$(references) Relation';
    this.statusRelation.show();

    this.disposables.push(
      this.statusContext,
      this.statusRelation,
      this.log,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.lastEditor = editor;
        }
        this.onEditorMoved();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.lastEditor = event.textEditor;
        }
        this.onEditorMoved();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('sourceInsight')) {
          return;
        }
        const configuration = vscode.workspace.getConfiguration('sourceInsight');
        this.followCursor = configuration.get<boolean>('followCursor') ?? true;
        this.autoReveal = configuration.get<boolean>('autoReveal') ?? false;
        this.trackingMode = readTrackingMode(configuration.get<string>('trackingMode'));
        this.state.followCursor = this.followCursor;
        this.state.trackingMode = this.trackingMode;
        this.state.autoReveal = this.autoReveal;
        this.postState();
        if (this.viewVisible && this.followCursor && this.trackingMode !== 'off') {
          this.scheduleAnalysis(false);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!this.isSupportedDocument(document)) {
          return;
        }
        this.service.clearCaches();
        if (this.viewVisible && this.followCursor && this.trackingMode !== 'off') {
          this.scheduleAnalysis(false, 120);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.lastEditor?.document === document) {
          this.lastEditor = undefined;
        }
      }),
    );
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    this.viewVisible = webviewView.visible;
    this.webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      enableForms: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.context.extensionUri);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.onWebviewMessage(message).catch((error: unknown) => {
          if (error instanceof AnalysisCancelledError) {
            return;
          }
          const text = error instanceof Error ? error.message : String(error);
          this.log.appendLine(`Webview action failed: ${text}`);
          this.showTransientError(`操作失败：${text}`);
        });
      }),
      webviewView.onDidChangeVisibility(() => {
        this.viewVisible = webviewView.visible;
        if (this.viewVisible) {
          this.postState();
          this.flushPendingFocus();
          if (this.followCursor && this.trackingMode !== 'off') {
            this.scheduleAnalysis(false);
          }
        }
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
          this.webviewReady = false;
          this.viewVisible = false;
        }
      }),
    );

    if (this.followCursor && this.trackingMode !== 'off') {
      this.scheduleAnalysis(false);
    }
  }

  async openPanel(pane?: 'context' | 'relation', analyze = true): Promise<void> {
    this.pendingFocus = pane;
    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.sourceInsight');
      } catch {
        // The user can still open the panel from the Panel view menu.
      }
    }
    this.flushPendingFocus();
    if (analyze) {
      this.scheduleAnalysis(true);
    }
  }

  async refresh(analyze = true): Promise<void> {
    if (!this.view) {
      await this.openPanel(undefined, analyze);
      return;
    }
    if (!this.viewVisible) {
      try {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      } catch {
        // Ignore focus failures.
      }
    }
    if (analyze) {
      this.service.clearCaches();
      this.scheduleAnalysis(true);
    }
  }

  async cycleLayout(): Promise<void> {
    if (!this.view || !this.webviewReady) {
      return;
    }
    void this.view.webview.postMessage({ type: 'cycleLayout' });
  }

  async copyRelationTree(): Promise<void> {
    if (!this.relationTree) {
      return;
    }
    const lines: string[] = [this.relationTree.root.name];
    if (this.relationTree.declaration) {
      lines.push(`  声明  ${this.relationTree.declaration.name}`);
    }
    const walk = (nodes: HostNode[], depth: number, arrow: string): void => {
      for (const node of nodes) {
        const counts = node.count > 1 ? ` ×${node.count}` : '';
        lines.push(`${'  '.repeat(depth + 1)}${arrow} ${node.name}${counts}`);
        walk(node.children, depth + 1, arrow);
      }
    };
    walk(this.relationTree.left, 0, '←');
    walk(this.relationTree.right, 0, '→');
    await vscode.env.clipboard.writeText(lines.join('\n'));
    vscode.window.setStatusBarMessage('Source Insight: 关系树已复制为文本', 2200);
  }

  async focusPane(pane: 'context' | 'relation'): Promise<void> {
    this.pendingFocus = pane;
    if (!this.view) {
      await this.openPanel(pane, false);
    } else {
      try {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      } catch {
        // Ignore focus failures.
      }
      this.flushPendingFocus();
    }
    if (!this.relationTree && !this.contextState) {
      this.scheduleAnalysis(true);
    }
  }

  async toggleFollow(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('sourceInsight');
    const next = !this.followCursor;
    await configuration.update('followCursor', next, vscode.ConfigurationTarget.Global);
    this.followCursor = next;
    this.state.followCursor = next;
    this.postState();
    this.updateStatusBar();
    vscode.window.setStatusBarMessage(
      next ? 'Source Insight: 已开启光标跟随' : 'Source Insight: 已暂停光标跟随',
      2500,
    );
    if (next && this.viewVisible) {
      this.scheduleAnalysis(false);
    }
  }

  async toggleLock(pane: 'context' | 'relation'): Promise<void> {
    if (pane === 'context') {
      this.contextLocked = !this.contextLocked;
    } else {
      this.relationLocked = !this.relationLocked;
    }
    this.state = {
      ...this.state,
      ...this.panelStateFields(),
    };
    this.postState();
  }

  async newRelationTab(): Promise<void> {
    if (!this.rootSymbol) {
      this.showTransientError('请先分析一个符号。');
      return;
    }
    if (this.relationTabs.length >= 6) {
      this.showTransientError('最多同时打开 6 个 Relation 视图。');
      return;
    }
    this.syncActiveTab();
    const id = `relation-${this.nextTabNumber}`;
    this.nextTabNumber += 1;
    this.relationTabs.push({
      id,
      mode: this.relationMode,
      depth: this.relationDepth,
    });
    this.activeTabId = id;
    this.relationTree = undefined;
    this.resetRelationHistory();
    await this.rebuildRelation(false);
  }

  async closeActiveRelationTab(): Promise<void> {
    await this.closeRelationTab(this.activeTabId);
  }

  async closeRelationTab(tabId: string): Promise<void> {
    if (this.relationTabs.length <= 1) {
      return;
    }
    const index = this.relationTabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) {
      return;
    }
    this.syncActiveTab();
    this.relationTabs.splice(index, 1);
    if (this.activeTabId !== tabId) {
      this.state = {
        ...this.state,
        ...this.panelStateFields(),
        updatedAt: Date.now(),
      };
      this.postState();
      return;
    }
    const next = this.relationTabs[Math.min(index, this.relationTabs.length - 1)];
    this.activeTabId = next.id;
    this.relationMode = next.mode;
    this.relationDepth = next.depth;
    this.relationTree = next.tree;
    if (
      this.relationTree &&
      this.rootSymbol &&
      this.relationTree.root.name === this.rootSymbol.name &&
      this.relationTree.mode === this.relationMode &&
      this.relationTree.depth === this.relationDepth
    ) {
      this.state = {
        ...this.state,
        ...this.panelStateFields(),
        updatedAt: Date.now(),
      };
      this.updateStatusBar();
      this.postState();
      return;
    }
    this.relationTree = undefined;
    await this.rebuildRelation(false);
  }

  async selectRelationTab(tabId: string): Promise<void> {
    if (tabId === this.activeTabId) {
      return;
    }
    const tab = this.relationTabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    this.syncActiveTab();
    this.activeTabId = tab.id;
    this.relationMode = tab.mode;
    this.relationDepth = tab.depth;
    if (
      tab.tree &&
      this.rootSymbol &&
      tab.tree.root.name === this.rootSymbol.name &&
      tab.tree.mode === this.relationMode &&
      tab.tree.depth === this.relationDepth
    ) {
      this.relationTree = tab.tree;
      this.state = {
        ...this.state,
        ...this.panelStateFields(),
        updatedAt: Date.now(),
      };
      this.updateStatusBar();
      this.postState();
      return;
    }
    this.relationTree = undefined;
    await this.rebuildRelation(false);
  }

  async setRelationMode(mode: RelationMode): Promise<void> {
    if (!this.rootSymbol) {
      return;
    }
    const available = availableModesFor(this.rootSymbol);
    if (!available.some((entry) => entry.value === mode)) {
      this.showTransientError('当前符号不支持该关系类型。');
      return;
    }
    this.relationMode = mode;
    await this.rebuildRelation(true);
  }

  async adjustDepth(delta: number): Promise<void> {
    const next = clampDepth(this.relationDepth + delta);
    if (next === this.relationDepth) {
      return;
    }
    this.relationDepth = next;
    await this.rebuildRelation(true);
  }

  async goToDefinition(): Promise<void> {
    if (this.contextState) {
      await this.openLocation(this.contextState.symbol.definition);
      return;
    }
    await vscode.commands.executeCommand('editor.action.revealDefinition');
  }

  async clear(): Promise<void> {
    this.analysisRevision += 1;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.rootSymbol = undefined;
    this.matches = [];
    this.matchSymbols = [];
    this.contextState = undefined;
    this.relationTree = undefined;
    this.contextHistory = [];
    this.contextHistoryIndex = -1;
    this.relationHistory = [];
    this.relationHistoryIndex = -1;
    this.lastAnalysisKey = '';
    this.state = this.emptyState();
    this.updateStatusBar();
    this.postState();
  }

  async previewNodeForTests(nodeId: string, siteIndex?: number): Promise<void> {
    await this.previewNode(nodeId, undefined, siteIndex);
  }

  getStateForTests(): {
    state: PanelState;
    hasSnapshot: boolean;
    debug?: {
      name: string;
      definition: SourceLocation;
      declaration?: SourceLocation;
      nodes: number;
      depth: number;
      mode: RelationMode;
    };
  } {
    return {
      state: JSON.parse(JSON.stringify(this.state)) as PanelState,
      hasSnapshot: Boolean(this.contextState || this.relationTree),
      debug: this.rootSymbol
        ? {
            name: this.rootSymbol.name,
            definition: this.rootSymbol.definition,
            declaration: this.rootSymbol.declaration,
            nodes: this.relationTree?.totalNodes ?? 0,
            depth: this.relationTree?.depth ?? this.relationDepth,
            mode: this.relationTree?.mode ?? this.relationMode,
          }
        : undefined,
    };
  }

  private onEditorMoved(): void {
    if (!this.followCursor || this.trackingMode === 'off' || Date.now() < this.suppressFollowUntil) {
      return;
    }
    if (this.contextLocked && this.relationLocked) {
      return;
    }
    if (!this.viewVisible) {
      if (this.autoReveal) {
        void this.openPanel(undefined, false);
      } else {
        return;
      }
    }
    const editor = this.activeEditor();
    if (!editor || !this.isSupportedDocument(editor.document)) {
      return;
    }
    this.scheduleAnalysis(false);
  }

  private scheduleAnalysis(manual: boolean, delayOverride?: number): void {
    const editor = this.activeEditor();
    if (!editor || !this.isSupportedDocument(editor.document)) {
      if (manual) {
        this.showTransientError('请先打开一个源代码文件。');
      }
      return;
    }

    this.lastEditor = editor;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const configuration = vscode.workspace.getConfiguration('sourceInsight');
    const configuredDelay = configuration.get<number>('debounceMs') ?? 280;
    const delay = delayOverride ?? (manual ? 0 : Math.max(80, configuredDelay));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runAnalysis(manual);
    }, delay);
  }

  private async runAnalysis(manual: boolean): Promise<void> {
    const editor = this.activeEditor();
    if (!editor || !this.isSupportedDocument(editor.document)) {
      return;
    }
    const key = this.selectionKey(editor);
    if (!manual && key && key === this.lastAnalysisKey) {
      return;
    }

    const revision = ++this.analysisRevision;
    const stale = () => revision !== this.analysisRevision;
    this.state = {
      ...this.state,
      revision,
      loading: true,
      followCursor: this.followCursor,
      trackingMode: this.trackingMode,
      autoReveal: this.autoReveal,
      status: this.contextState || this.relationTree ? 'ready' : 'loading',
      updatedAt: Date.now(),
    };
    this.postState();

    try {
      const resolution = await this.service.resolveEditorSymbol(
        editor,
        this.trackingMode,
        manual,
        stale,
      );
      if (stale()) {
        return;
      }
      const root = resolution.symbol;
      await this.service.findDeclarationFromReferences(root, stale).catch(() => undefined);
      if (stale()) {
        return;
      }

      const sameRoot = this.rootSymbol?.key === root.key;
      const available = availableModesFor(root);
      const mode = sameRoot && available.some((entry) => entry.value === this.relationMode)
        ? this.relationMode
        : defaultModeFor(root);
      const depth = this.relationDepth;
      const needContext = manual || !this.contextLocked || !this.contextState;
      const needRelation = manual || !this.relationLocked || !this.relationTree;

      let context = this.contextState?.context;
      let tree = this.relationTree;
      if (needContext) {
        context = await this.service.getContext(
          root,
          'definition',
          resolution.matchSymbols,
          resolution.matches,
          0,
          stale,
        );
      }
      if (stale()) {
        return;
      }
      if (needRelation) {
        tree = await this.builder.build(root, mode, depth, stale);
      }
      if (stale()) {
        return;
      }

      this.rootSymbol = root;
      this.matches = resolution.matches;
      this.matchSymbols = resolution.matchSymbols;
      if (needContext && context) {
        this.contextState = {
          context,
          symbol: root,
          view: 'definition',
          matches: resolution.matches,
          matchSymbols: resolution.matchSymbols,
          activeMatch: 0,
        };
        this.resetContextHistory();
      }
      if (needRelation && tree) {
        this.relationTree = tree;
        this.relationMode = mode;
        this.relationDepth = depth;
        this.syncActiveTab();
        this.resetRelationHistory();
      }
      this.lastAnalysisKey = key;
      this.state = {
        revision,
        status: 'ready',
        loading: false,
        followCursor: this.followCursor,
        trackingMode: this.trackingMode,
        autoReveal: this.autoReveal,
        ...this.panelStateFields(),
        updatedAt: Date.now(),
      };
      this.updateStatusBar();
      this.postState();
    } catch (error) {
      this.handleAnalysisError(error, revision, manual);
    }
  }

  private async rebuildRelation(pushHistory = false): Promise<void> {
    if (!this.rootSymbol) {
      return;
    }
    const revision = ++this.analysisRevision;
    const stale = () => revision !== this.analysisRevision;
    this.state = {
      ...this.state,
      revision,
      loading: true,
      status: 'ready',
      updatedAt: Date.now(),
    };
    this.postState();
    try {
      const tree = await this.builder.build(
        this.rootSymbol,
        this.relationMode,
        this.relationDepth,
        stale,
      );
      if (stale()) {
        return;
      }
      this.relationTree = tree;
      this.syncActiveTab();
      if (pushHistory) {
        this.pushRelationHistory();
      }
      this.state = {
        ...this.state,
        revision,
        loading: false,
        status: 'ready',
        ...this.panelStateFields(),
        updatedAt: Date.now(),
      };
      this.updateStatusBar();
      this.postState();
    } catch (error) {
      this.handleAnalysisError(error, revision, true);
    }
  }

  private async rebuildContext(
    symbol: HostSymbol,
    view: ContextViewKind,
    matches: ContextMatchView[],
    matchSymbols: HostSymbol[],
    activeMatch: number,
    pushHistory = true,
    focus?: ContextFocus,
  ): Promise<void> {
    const revision = ++this.analysisRevision;
    const stale = () => revision !== this.analysisRevision;
    this.state = {
      ...this.state,
      revision,
      loading: true,
      status: 'ready',
      updatedAt: Date.now(),
    };
    this.postState();
    try {
      const context = await this.service.getContext(
        symbol,
        view,
        matchSymbols,
        matches,
        activeMatch,
        stale,
        focus,
      );
      if (stale()) {
        return;
      }
      this.contextState = {
        context,
        symbol,
        view: context.activeView,
        matches,
        matchSymbols,
        activeMatch,
        focus,
      };
      if (pushHistory) {
        this.pushContextHistory(symbol, context.activeView);
      }
      this.state = {
        ...this.state,
        revision,
        loading: false,
        status: 'ready',
        ...this.panelStateFields(),
        updatedAt: Date.now(),
      };
      this.updateStatusBar();
      this.postState();
    } catch (error) {
      this.handleAnalysisError(error, revision, true);
    }
  }

  private async activateSymbol(
    symbol: HostSymbol,
    mode: RelationMode,
  ): Promise<void> {
    const revision = ++this.analysisRevision;
    const stale = () => revision !== this.analysisRevision;
    await this.service.decorateDeclaration(symbol, stale).catch(() => undefined);
    await this.service.findDeclarationFromReferences(symbol, stale).catch(() => undefined);
    const available = availableModesFor(symbol);
    const effectiveMode = available.some((entry) => entry.value === mode)
      ? mode
      : available[0].value;
    const context = await this.service.getContext(
      symbol,
      'definition',
      [symbol],
      [{ index: 0, label: symbol.name, kindLabel: symbol.kindLabel, detail: symbol.detail }],
      0,
      stale,
    );
    const tree = await this.builder.build(symbol, effectiveMode, this.relationDepth, stale);
    if (stale()) {
      return;
    }
    this.rootSymbol = symbol;
    this.matches = [{
      index: 0,
      label: symbol.name,
      kindLabel: symbol.kindLabel,
      detail: symbol.detail,
    }];
    this.matchSymbols = [symbol];
    this.contextState = {
      context,
      symbol,
      view: 'definition',
      matches: this.matches,
      matchSymbols: this.matchSymbols,
      activeMatch: 0,
    };
    this.relationTree = tree;
    this.relationMode = effectiveMode;
    this.syncActiveTab();
    this.resetContextHistory();
    this.resetRelationHistory();
    this.state = {
      ...this.state,
      status: 'ready',
      loading: false,
      ...this.panelStateFields(),
      updatedAt: Date.now(),
    };
    this.updateStatusBar();
    this.postState();
  }

  private async onWebviewMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        this.postState();
        this.flushPendingFocus();
        break;
      case 'openNode':
        await this.openNode(message.nodeId, message.siteIndex);
        break;
      case 'previewNode':
        await this.previewNode(message.nodeId, message.view, message.siteIndex);
        break;
      case 'nodeAction':
        await this.onNodeAction(message.nodeId, message.action, message.levels);
        break;
      case 'openContext':
        await this.openContext(message.line);
        break;
      case 'setMode':
        await this.setRelationMode(message.mode);
        break;
      case 'setDepth':
        this.relationDepth = clampDepth(message.depth);
        await this.rebuildRelation(true);
        break;
      case 'selectMatch':
        await this.selectMatch(message.index);
        break;
      case 'setContextView':
        await this.setContextView(message.view);
        break;
      case 'contextHistory':
        await this.navigateContextHistory(message.direction);
        break;
      case 'relationHistory':
        await this.navigateRelationHistory(message.direction);
        break;
      case 'toggleLock':
        await this.toggleLock(message.pane);
        break;
      case 'requestExpand':
        await this.expandNode(message.nodeId, message.levels ?? 1);
        break;
      case 'refresh':
        this.service.clearCaches();
        await this.runAnalysis(true);
        break;
      case 'toggleFollow':
        await this.toggleFollow();
        break;
      case 'focusPane':
        this.pendingFocus = message.pane;
        this.flushPendingFocus();
        break;
      case 'copyText':
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.setStatusBarMessage('Source Insight: 已复制', 1600);
        break;
      case 'setLayout':
        break;
      case 'newRelationTab':
        await this.newRelationTab();
        break;
      case 'closeRelationTab':
        await this.closeRelationTab(message.tabId);
        break;
      case 'selectRelationTab':
        await this.selectRelationTab(message.tabId);
        break;
      default:
        break;
    }
  }

  private async openNode(nodeId: string, siteIndex?: number): Promise<void> {
    const node = this.relationTree?.nodeMap.get(nodeId);
    if (!node) {
      return;
    }
    const site = node.sites[siteIndex ?? 0] ?? node.sites[0];
    await this.openLocation(site?.location ?? node.openLocation);
  }

  private async previewNode(
    nodeId: string,
    view?: ContextViewKind,
    siteIndex?: number,
  ): Promise<void> {
    if (this.contextLocked) {
      return;
    }
    const node = this.relationTree?.nodeMap.get(nodeId);
    if (!node) {
      return;
    }
    const root = this.relationTree?.root.symbol;
    const site = node.sites[siteIndex ?? 0] ?? node.sites[0];
    if (site && root) {
      const owner = node.symbol ?? root;
      await this.rebuildContext(
        owner,
        'definition',
        [{ index: 0, label: owner.name, kindLabel: owner.kindLabel, detail: owner.detail }],
        [owner],
        0,
        true,
        {
          location: site.location,
          targetName: root.name,
          targetLocation: site.location,
        },
      );
      return;
    }
    if (!node.symbol) {
      return;
    }
    const symbol = node.symbol;
    let targetView: ContextViewKind = view ?? 'definition';
    if (!view) {
      if (node.role === 'declaration') {
        targetView = 'declaration';
      } else if (node.role === 'type') {
        targetView = 'definition';
      }
    }
    await this.rebuildContext(
      symbol,
      targetView,
      [{ index: 0, label: symbol.name, kindLabel: symbol.kindLabel, detail: symbol.detail }],
      [symbol],
      0,
      true,
    );
  }

  private async onNodeAction(
    nodeId: string,
    action: NodeAction,
    levels: number | undefined,
  ): Promise<void> {
    const node = this.relationTree?.nodeMap.get(nodeId);
    if (!node) {
      return;
    }
    if (action === 'open') {
      await this.openNode(nodeId);
      return;
    }
    if (action === 'copy') {
      await vscode.env.clipboard.writeText(node.name);
      vscode.window.setStatusBarMessage(`Source Insight: 已复制 ${node.name}`, 1600);
      return;
    }
    if (action === 'expand') {
      await this.expandNode(nodeId, levels ?? 1);
      return;
    }
    if (action === 'collapse') {
      return;
    }
    if (action === 'revealInContext') {
      await this.previewNode(nodeId);
      return;
    }
    if (!node.symbol) {
      this.showTransientError('该节点没有可分析的符号。');
      return;
    }
    const map: Record<string, RelationMode> = {
      showCallers: 'callers',
      showCallees: 'callees',
      showReferences: 'references',
      showType: 'type',
      showContains: 'contains',
      showDerived: 'derived',
      setRoot: defaultModeFor(node.symbol),
    };
    const mode = map[action] ?? defaultModeFor(node.symbol);
    await this.activateSymbol(node.symbol, mode);
  }

  private async expandNode(nodeId: string, levels: number): Promise<void> {
    if (!this.relationTree) {
      return;
    }
    const revision = ++this.analysisRevision;
    const stale = () => revision !== this.analysisRevision;
    const tree = await this.builder.expandNode(
      this.relationTree,
      nodeId,
      Math.max(1, Math.min(3, Math.round(levels))),
      stale,
    );
    if (stale()) {
      return;
    }
    this.relationTree = tree;
    this.syncActiveTab();
    this.state = {
      ...this.state,
      revision,
      loading: false,
      status: 'ready',
      ...this.panelStateFields(),
      updatedAt: Date.now(),
    };
    this.updateStatusBar();
    this.postState();
  }

  private async selectMatch(index: number): Promise<void> {
    const symbol = this.matchSymbols[index];
    if (!symbol || !this.rootSymbol) {
      return;
    }
    const revision = ++this.analysisRevision;
    const stale = () => revision !== this.analysisRevision;
    await this.service.decorateDeclaration(symbol, stale).catch(() => undefined);
    await this.service.findDeclarationFromReferences(symbol, stale).catch(() => undefined);
    const available = availableModesFor(symbol);
    const mode = available.some((entry) => entry.value === this.relationMode)
      ? this.relationMode
      : defaultModeFor(symbol);
    const context = await this.service.getContext(
      symbol,
      'definition',
      this.matchSymbols,
      this.matches,
      index,
      stale,
    );
    const tree = await this.builder.build(symbol, mode, this.relationDepth, stale);
    if (stale()) {
      return;
    }
    this.rootSymbol = symbol;
    this.contextState = {
      context,
      symbol,
      view: 'definition',
      matches: this.matches,
      matchSymbols: this.matchSymbols,
      activeMatch: index,
    };
    this.relationTree = tree;
    this.relationMode = mode;
    this.syncActiveTab();
    this.resetContextHistory();
    this.resetRelationHistory();
    this.state = {
      ...this.state,
      revision,
      status: 'ready',
      loading: false,
      ...this.panelStateFields(),
      updatedAt: Date.now(),
    };
    this.updateStatusBar();
    this.postState();
  }

  private async setContextView(view: ContextViewKind): Promise<void> {
    if (!this.contextState) {
      return;
    }
    if (!this.contextState.context.availableViews.includes(view)) {
      return;
    }
    await this.rebuildContext(
      this.contextState.symbol,
      view,
      this.contextState.matches,
      this.contextState.matchSymbols,
      this.contextState.activeMatch,
      true,
    );
  }

  private async openContext(line?: number): Promise<void> {
    if (!this.contextState) {
      return;
    }
    const state = this.contextState;
    let location = state.context.focusLocation ?? state.symbol.definition;
    if (!state.context.focusLocation && state.view === 'declaration' && state.symbol.declaration) {
      location = state.symbol.declaration;
    } else if (!state.context.focusLocation && state.view === 'type' && state.context.typeSymbol) {
      location = state.context.typeSymbol.definition;
    }
    if (line !== undefined) {
      location = {
        ...location,
        startLine: line,
        endLine: line,
        startCharacter: 0,
        endCharacter: 0,
      };
    }
    await this.openLocation(location);
  }

  private async navigateContextHistory(direction: 'back' | 'forward'): Promise<void> {
    const next = this.contextHistoryIndex + (direction === 'back' ? -1 : 1);
    const entry = this.contextHistory[next];
    if (!entry) {
      return;
    }
    this.contextHistoryIndex = next;
    await this.rebuildContext(
      entry.symbol,
      entry.view,
      [{ index: 0, label: entry.symbol.name, kindLabel: entry.symbol.kindLabel, detail: entry.symbol.detail }],
      [entry.symbol],
      0,
      false,
    );
  }

  private async navigateRelationHistory(direction: 'back' | 'forward'): Promise<void> {
    const next = this.relationHistoryIndex + (direction === 'back' ? -1 : 1);
    const entry = this.relationHistory[next];
    if (!entry) {
      return;
    }
    this.relationHistoryIndex = next;
    this.rootSymbol = entry.root;
    this.relationMode = entry.mode;
    this.relationDepth = entry.depth;
    const revision = ++this.analysisRevision;
    const stale = () => revision !== this.analysisRevision;
    const tree = await this.builder.build(entry.root, entry.mode, entry.depth, stale);
    if (stale()) {
      return;
    }
    this.relationTree = tree;
    this.syncActiveTab();
    this.state = {
      ...this.state,
      revision,
      status: 'ready',
      loading: false,
      ...this.panelStateFields(),
      updatedAt: Date.now(),
    };
    this.updateStatusBar();
    this.postState();
  }

  private pushContextHistory(symbol: HostSymbol, view: ContextViewKind): void {
    this.contextHistory = this.contextHistory.slice(0, this.contextHistoryIndex + 1);
    this.contextHistory.push({ symbol, view });
    if (this.contextHistory.length > 40) {
      this.contextHistory.shift();
    }
    this.contextHistoryIndex = this.contextHistory.length - 1;
  }

  private resetContextHistory(): void {
    if (!this.contextState) {
      return;
    }
    this.contextHistory = [{ symbol: this.contextState.symbol, view: this.contextState.view }];
    this.contextHistoryIndex = 0;
  }

  private pushRelationHistory(): void {
    if (!this.rootSymbol) {
      return;
    }
    this.relationHistory = this.relationHistory.slice(0, this.relationHistoryIndex + 1);
    this.relationHistory.push({
      root: this.rootSymbol,
      mode: this.relationMode,
      depth: this.relationDepth,
    });
    if (this.relationHistory.length > 30) {
      this.relationHistory.shift();
    }
    this.relationHistoryIndex = this.relationHistory.length - 1;
  }

  private resetRelationHistory(): void {
    if (!this.rootSymbol) {
      return;
    }
    this.relationHistory = [{
      root: this.rootSymbol,
      mode: this.relationMode,
      depth: this.relationDepth,
    }];
    this.relationHistoryIndex = 0;
  }

  private async openLocation(location: SourceLocation): Promise<void> {
    try {
      const uri = vscode.Uri.parse(location.uri);
      const range = new vscode.Range(
        location.startLine,
        location.startCharacter,
        location.endLine,
        location.endCharacter,
      );
      this.suppressFollowUntil = Date.now() + 1200;
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        selection: range,
      });
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.lastEditor = editor;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Source Insight: 无法打开位置：${message}`);
    }
  }

  private panelStateFields(): Pick<PanelState, 'context' | 'relation'> {
    return {
      context: this.contextState ? this.toContextView(this.contextState) : undefined,
      relation: this.relationTree ? this.toRelationView(this.relationTree) : undefined,
    };
  }

  private syncActiveTab(): void {
    const tab = this.relationTabs.find((entry) => entry.id === this.activeTabId);
    if (!tab) {
      return;
    }
    tab.mode = this.relationMode;
    tab.depth = this.relationDepth;
    tab.tree = this.relationTree;
  }

  private relationTabsView(): RelationTabView[] {
    const labels = this.relationTabs.map((tab) => {
      const tree = tab.tree;
      if (tree && this.rootSymbol && tree.root.name !== this.rootSymbol.name) {
        return tree.root.name;
      }
      const symbol = tree?.root.symbol ?? this.rootSymbol;
      const options = symbol ? availableModesFor(symbol) : [];
      return options.find((entry) => entry.value === tab.mode)?.label
        ?? tab.mode;
    });
    const counts = new Map<string, number>();
    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return this.relationTabs.map((tab, index) => {
      const base = labels[index];
      const total = counts.get(base) ?? 1;
      let label = base;
      if (total > 1) {
        const ordinal = (seen.get(base) ?? 0) + 1;
        seen.set(base, ordinal);
        label = `${base} ${ordinal}`;
      }
      return {
        id: tab.id,
        label,
        active: tab.id === this.activeTabId,
      };
    });
  }

  private toContextView(state: ContextPaneState): ContextView {
    const context = state.context;
    const config = readConfig();
    const filePath = vscode.Uri.parse(context.fileUri).fsPath;
    return {
      symbolName: context.symbol.name,
      targetName: context.targetName,
      fileName: fileNameFromUri(context.fileUri),
      filePath,
      kindLabel: context.symbol.kindLabel,
      isFunction: context.symbol.isFunction,
      languageId: context.languageId,
      matches: context.matches,
      activeMatch: state.activeMatch,
      availableViews: context.availableViews,
      activeView: state.view,
      lines: context.lines,
      startLine: context.startLine,
      endLine: context.endLine,
      targetStartLine: context.targetStartLine,
      targetEndLine: context.targetEndLine,
      targetStartCharacter: context.targetStartCharacter,
      targetEndCharacter: context.targetEndCharacter,
      truncatedTop: context.truncatedTop,
      truncatedBottom: context.truncatedBottom,
      totalLines: context.totalLines,
      typeName: context.typeSymbol?.name,
      showLineNumbers: config.contextLineNumbers,
      locked: this.contextLocked,
      canGoBack: this.contextHistoryIndex > 0,
      canGoForward: this.contextHistoryIndex >= 0 &&
        this.contextHistoryIndex < this.contextHistory.length - 1,
      notice: context.notice,
    };
  }

  private toRelationView(tree: HostRelationTree): RelationView {
    const relationRoot = tree.root.symbol ?? this.rootSymbol;
    const available = relationRoot
      ? availableModesFor(relationRoot)
      : [{ value: tree.mode, label: '引用' }];
    const config = readConfig();
    return {
      root: this.toNodeView(tree.root),
      declaration: tree.declaration ? this.toNodeView(tree.declaration) : undefined,
      left: tree.left.map((node) => this.toNodeView(node)),
      right: tree.right.map((node) => this.toNodeView(node)),
      mode: tree.mode,
      modeLabel: available.find((entry) => entry.value === tree.mode)?.label ?? '关系',
      availableModes: available,
      depth: tree.depth,
      maxDepth: MAX_DEPTH,
      rootName: tree.root.name,
      rootKindLabel: tree.root.kindLabel,
      isFunction: Boolean(relationRoot?.isFunction),
      counts: tree.counts,
      totalNodes: tree.totalNodes,
      warnings: tree.warnings,
      locked: this.relationLocked,
      canGoBack: this.relationHistoryIndex > 0,
      canGoForward: this.relationHistoryIndex >= 0 &&
        this.relationHistoryIndex < this.relationHistory.length - 1,
      showLocations: config.showLocations,
      graph: {
        lineStyle: config.relationLineStyle,
        spacing: config.relationSpacing,
        arrows: config.relationArrows,
        shadow: config.relationNodeShadow,
      },
      tabs: this.relationTabsView(),
      activeTabId: this.activeTabId,
    };
  }

  private toNodeView(node: HostNode): RelationNodeView {
    return {
      id: node.id,
      name: node.name,
      role: node.role,
      kindLabel: node.kindLabel,
      count: node.count > 1 ? node.count : undefined,
      readCount: node.readCount || undefined,
      writeCount: node.writeCount || undefined,
      sites: node.sites.length > 0
        ? node.sites.map((site) => ({
            line: site.location.startLine + 1,
            role: site.role,
          }))
        : undefined,
      expandable: node.expandable || node.children.length > 0,
      isFunction: node.symbol?.isFunction,
      isContainer: node.symbol?.isContainer,
      isVariable: node.symbol?.isVariable,
      locationLabel: node.locationLabel,
      children: node.children.map((child) => this.toNodeView(child)),
    };
  }

  private handleAnalysisError(error: unknown, revision: number, manual: boolean): void {
    if (revision !== this.analysisRevision || error instanceof AnalysisCancelledError) {
      return;
    }
    if (error instanceof NoSymbolError || error instanceof NoDefinitionError) {
      this.state.loading = false;
      if (manual) {
        if (!this.contextState && !this.relationTree) {
          this.state = {
            ...this.emptyState(),
            revision,
            notice: error.message,
          };
        } else {
          this.showTransientError(error.message);
        }
      }
      this.state.revision = revision;
      this.postState();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.log.appendLine(`Analysis failed: ${message}`);
    if (manual) {
      this.showTransientError(`分析失败：${message}`);
    }
    this.state = {
      ...this.state,
      revision,
      loading: false,
      status: this.contextState || this.relationTree ? this.state.status : 'error',
      error: this.contextState || this.relationTree ? undefined : message,
      updatedAt: Date.now(),
    };
    this.updateStatusBar();
    this.postState();
  }

  private postState(): void {
    if (!this.view || !this.webviewReady) {
      return;
    }
    this.state.revision = this.analysisRevision;
    this.state.followCursor = this.followCursor;
    this.state.trackingMode = this.trackingMode;
    this.state.autoReveal = this.autoReveal;
    void this.view.webview.postMessage({ type: 'state', state: this.state });
  }

  private flushPendingFocus(): void {
    if (!this.view || !this.webviewReady) {
      return;
    }
    const pane = this.pendingFocus;
    if (!pane) {
      return;
    }
    this.pendingFocus = undefined;
    void this.view.webview.postMessage({ type: 'focusPane', pane });
  }

  private updateStatusBar(): void {
    if (this.contextState) {
      const symbol = this.contextState.symbol;
      const shortName = symbol.name.length > 30 ? `${symbol.name.slice(0, 29)}…` : symbol.name;
      this.statusContext.text = `${this.contextLocked ? '$(lock) ' : ''}$(symbol-method) ${shortName}`;
      this.statusContext.tooltip = `${symbol.name} · ${symbol.kindLabel}`;
    } else {
      this.statusContext.text = '$(symbol-method) Source Insight';
      this.statusContext.tooltip = 'Source Insight Context 窗口';
    }

    if (this.relationTree) {
      const root = this.relationTree.root;
      const counts = this.relationTree.counts;
      const detail = this.relationMode === 'callees'
        ? `${counts.callees} 被调用`
        : this.relationMode === 'both'
          ? `${counts.callers} 调用者 / ${counts.callees} 被调用`
          : this.relationMode === 'contains'
            ? `${counts.members} 成员`
            : `${counts.callers || counts.references} 关系`;
      this.statusRelation.text = `${this.relationLocked ? '$(lock) ' : ''}$(references) ${detail}`;
      this.statusRelation.tooltip = `${root.name} · ${this.relationDepth} 层 · ${detail}`;
    } else {
      this.statusRelation.text = '$(references) Relation';
      this.statusRelation.tooltip = 'Source Insight Relation 窗口';
    }
  }

  private activeEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && this.isSupportedDocument(active.document)) {
      return active;
    }
    if (this.lastEditor && this.isSupportedDocument(this.lastEditor.document)) {
      return this.lastEditor;
    }
    return active;
  }

  private isSupportedDocument(document: vscode.TextDocument): boolean {
    const scheme = document.uri.scheme;
    if (['output', 'debug', 'vscode', 'git', 'gitlens', 'search-editor'].includes(scheme)) {
      return false;
    }
    return document.uri.toString() !== '';
  }

  private selectionKey(editor: vscode.TextEditor): string {
    const document = editor.document;
    const active = editor.selection.active;
    const range = document.getWordRangeAtPosition(active, WORD_PATTERN);
    const word = range ? document.getText(range) : '';
    return [
      document.uri.toString(),
      document.version,
      editor.selection.anchor.line,
      editor.selection.anchor.character,
      active.line,
      active.character,
      word,
      this.trackingMode,
    ].join(':');
  }

  private showTransientError(message: string): void {
    vscode.window.setStatusBarMessage(`Source Insight: ${message}`, 5000);
  }

  private emptyState(): PanelState {
    return {
      revision: this.analysisRevision,
      status: 'empty',
      loading: false,
      followCursor: this.followCursor,
      trackingMode: this.trackingMode,
      autoReveal: this.autoReveal,
      updatedAt: Date.now(),
    };
  }

  dispose(): void {
    this.analysisRevision += 1;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

function clampDepth(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_DEPTH, Math.max(1, Math.round(value)));
}

function readTrackingMode(value: unknown): TrackingMode {
  if (value === 'enclosing' || value === 'off') {
    return value;
  }
  return 'symbol';
}


