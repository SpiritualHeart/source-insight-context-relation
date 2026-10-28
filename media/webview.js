(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const els = {
    app: $('app'),
    loadingBar: $('loading-bar'),
    providerState: $('provider-state'),
    trackingState: $('tracking-state'),
    followButton: $('follow-button'),
    searchButton: $('search-button'),
    indexButton: $('index-button'),
    settingsButton: $('settings-button'),
    refreshButton: $('refresh-button'),
    split: $('split'),
    contextPane: $('context-pane'),
    relationPane: $('relation-pane'),
    splitter: $('splitter'),
    contextTitle: $('context-title'),
    contextFile: $('context-file'),
    kindBadge: $('kind-badge'),
    matchNav: $('match-nav'),
    matchLabel: $('match-label'),
    matchPrev: $('match-prev'),
    matchNext: $('match-next'),
    contextBack: $('context-back'),
    contextForward: $('context-forward'),
    contextLock: $('context-lock'),
    openContextButton: $('open-context-button'),
    contextViewbar: $('context-viewbar'),
    viewDefinition: $('view-definition'),
    viewDeclaration: $('view-declaration'),
    viewType: $('view-type'),
    typeName: $('type-name'),
    contextBody: $('context-body'),
    contextPlaceholder: $('context-placeholder'),
    codeScroll: $('code-scroll'),
    contextNotice: $('context-notice'),
    codeTable: $('code-table'),
    contextFooter: $('context-footer'),
    contextSummary: $('context-summary'),
    copyContextButton: $('copy-context-button'),
    gotoButton: $('goto-button'),
    relationTabList: $('relation-tab-list'),
    newRelationTab: $('new-relation-tab'),
    relationTitle: $('relation-title'),
    relationKindBadge: $('relation-kind-badge'),
    relationBack: $('relation-back'),
    relationForward: $('relation-forward'),
    relationLock: $('relation-lock'),
    relationRefreshButton: $('relation-refresh-button'),
    layoutHorizontal: $('layout-horizontal'),
    layoutVertical: $('layout-vertical'),
    layoutOutline: $('layout-outline'),
    relationMode: $('relation-mode'),
    depthMinus: $('depth-minus'),
    depthPlus: $('depth-plus'),
    depthValue: $('depth-value'),
    relationCounts: $('relation-counts'),
    expandAllButton: $('expand-all-button'),
    collapseAllButton: $('collapse-all-button'),
    relationBody: $('relation-body'),
    relationPlaceholder: $('relation-placeholder'),
    graphScroll: $('graph-scroll'),
    graphStage: $('graph-stage'),
    connectors: $('connectors'),
    tree: $('tree'),
    relationWarnings: $('relation-warnings'),
    relationFooter: $('relation-footer'),
    relationSummary: $('relation-summary'),
    emptyState: $('empty-state'),
    emptyTitle: $('empty-title'),
    emptyCopy: $('empty-copy'),
    emptyNote: $('empty-note'),
    emptyRefresh: $('empty-refresh'),
    emptyFollow: $('empty-follow'),
    nodeMenu: $('node-menu'),
    nodeMenuTitle: $('node-menu-title'),
    nodeMenuItems: $('node-menu-items'),
    toast: $('toast'),
  };

  const defaultEmptyCopy = els.emptyCopy.innerHTML;
  const savedState = vscode.getState() || {};
  let splitRatio = typeof savedState.splitRatio === 'number'
    ? clamp(savedState.splitRatio, 0.28, 0.72)
    : 0.49;
  let layout = ['horizontal', 'vertical', 'outline'].includes(savedState.layout)
    ? savedState.layout
    : 'horizontal';
  let state = {
    status: 'empty',
    loading: false,
    followCursor: true,
    trackingMode: 'symbol',
    autoReveal: false,
  };
  let lastContextKey = '';
  let lastRelationKey = '';
  let lastRelationIdentity = '';
  let nodeMap = new Map();
  let selectedNodeId = '';
  let collapsedNodes = new Set();
  let deferredLoading = new Set();
  let menuNodeId = '';
  let toastTimer = 0;
  let connectorFrame = 0;
  let resizeObserver = null;

  const ROLE_LABEL = {
    definition: '定义',
    declaration: '声明',
    caller: '调用者',
    callee: '被调用',
    reference: '引用',
    member: '成员',
    type: '类型',
    derived: '派生',
    global: '全局',
  };

  const VIEW_LABEL = {
    definition: '定义',
    declaration: '声明',
    type: '类型',
  };

  const TRACKING_LABEL = {
    symbol: '符号',
    enclosing: '所在函数',
    off: '已关闭',
  };

  function post(message) {
    vscode.postMessage(message);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('is-visible'), 2200);
  }

  function saveUiState() {
    const old = vscode.getState() || {};
    vscode.setState(Object.assign({}, old, { splitRatio, layout }));
  }

  function hasData() {
    return Boolean(state.context || state.relation);
  }

  function render() {
    const data = hasData();
    const busy = Boolean(state.loading);
    els.app.classList.toggle('is-empty', !data);
    els.emptyState.hidden = data;
    els.loadingBar.classList.toggle('is-active', busy);
    els.refreshButton.classList.toggle('is-spinning', busy);
    els.followButton.classList.toggle('is-active', Boolean(state.followCursor));
    els.followButton.setAttribute('aria-pressed', String(Boolean(state.followCursor)));
    els.followButton.title = state.followCursor
      ? '正在跟随编辑器光标（点击暂停）'
      : '光标跟随已暂停（点击开启）';
    els.trackingState.textContent = `跟踪: ${TRACKING_LABEL[state.trackingMode] || '符号'}`;
    els.trackingState.classList.toggle('is-off', state.trackingMode === 'off');

    renderEmptyState(data, busy);
    renderProviderState(data, busy);

    if (!data) {
      return;
    }
    if (state.context) {
      renderContext(state.context);
    }
    if (state.relation) {
      renderRelation(state.relation);
    }
  }

  function renderProviderState(data, busy) {
    els.providerState.classList.toggle('is-busy', busy);
    if (busy) {
      const name = state.relation?.rootName || state.context?.symbolName || '';
      els.providerState.textContent = name ? `分析 ${name}…` : '正在分析…';
      return;
    }
    if (!data) {
      els.providerState.textContent = '等待选择符号';
      return;
    }
    const context = state.context;
    const relation = state.relation;
    const kind = context?.kindLabel || relation?.rootKindLabel || '符号';
    els.providerState.textContent = kind;
    els.providerState.title = relation?.rootName || context?.symbolName || '';
  }

  function renderEmptyState(data, busy) {
    if (data) {
      return;
    }
    els.emptyState.classList.toggle('is-busy', busy);
    els.emptyCopy.innerHTML = defaultEmptyCopy;
    els.emptyNote.classList.remove('is-error');
    els.emptyRefresh.disabled = busy;
    els.emptyFollow.classList.toggle('is-active', Boolean(state.followCursor));
    els.emptyFollow.textContent = state.followCursor ? '暂停光标跟随' : '开启光标跟随';

    if (state.status === 'error') {
      els.emptyTitle.textContent = '分析失败';
      els.emptyCopy.textContent =
        '无法读取当前符号。请确认文件已保存、Language Server 已就绪，然后重试。';
      els.emptyNote.textContent = state.error || '';
      els.emptyNote.classList.add('is-error');
      return;
    }
    if (busy) {
      els.emptyTitle.textContent = '正在读取上下文与关系…';
      els.emptyCopy.textContent = '第一次分析可能需要等待 Language Server 建立索引。';
      els.emptyNote.textContent = state.context?.symbolName || state.relation?.rootName || '';
      return;
    }
    els.emptyTitle.textContent = '把光标放在函数或变量上';
    els.emptyNote.textContent = state.notice || '';
  }

  /* ------------------------------------------------------------- context */

  function renderContext(context) {
    els.contextTitle.textContent = context.symbolName;
    els.contextTitle.title = context.symbolName;
    els.contextFile.hidden = !context.fileName;
    els.contextFile.textContent = context.fileName || '';
    els.contextFile.title = context.filePath || context.fileName || '';
    els.kindBadge.hidden = false;
    els.kindBadge.textContent = context.kindLabel;
    els.contextFooter.hidden = false;
    els.codeScroll.hidden = false;
    els.contextLock.classList.toggle('is-active', context.locked);
    els.contextLock.title = context.locked ? 'Context 已锁定' : '锁定 Context';
    els.contextLock.setAttribute('aria-pressed', String(context.locked));
    els.contextBack.disabled = !context.canGoBack;
    els.contextForward.disabled = !context.canGoForward;
    els.contextSummary.textContent = `${context.kindLabel} · ${VIEW_LABEL[context.activeView] || '定义'}`;
    els.codeTable.classList.toggle('hide-line-numbers', context.showLineNumbers === false);

    const matchCount = context.matches.length;
    els.matchNav.hidden = matchCount <= 1;
    els.matchLabel.textContent = `${context.activeMatch + 1} / ${matchCount}`;
    els.matchPrev.disabled = context.activeMatch <= 0;
    els.matchNext.disabled = context.activeMatch >= matchCount - 1;

    const available = new Set(context.availableViews);
    for (const [view, button] of [
      ['definition', els.viewDefinition],
      ['declaration', els.viewDeclaration],
      ['type', els.viewType],
    ]) {
      button.disabled = !available.has(view);
      button.classList.toggle('is-active', context.activeView === view);
      button.hidden = view !== 'definition' && !available.has(view);
    }
    els.typeName.hidden = !context.typeName;
    els.typeName.textContent = context.typeName ? `类型: ${context.typeName}` : '';

    const notice = contextNoticeText(context);
    els.contextNotice.hidden = !notice;
    els.contextNotice.textContent = notice;

    const key = [
      context.symbolName,
      context.kindLabel,
      context.activeView,
      context.activeMatch,
      context.startLine,
      context.endLine,
      context.targetStartLine,
      fingerprintLines(context.lines),
    ].join(':');
    if (key === lastContextKey) {
      return;
    }
    lastContextKey = key;

    const highlighter = createHighlighter(context.languageId || '');
    const targetName = context.targetName || context.symbolName;
    const rows = [];
    for (const item of context.lines) {
      const isTarget =
        item.line >= context.targetStartLine && item.line <= context.targetEndLine;
      const column = isTarget ? context.targetStartCharacter : 0;
      const marker = isTarget
        ? '<span class="definition-marker" aria-hidden="true"></span>'
        : '';
      let highlighted = highlighter(item.text) || '&#8203;';
      if (isTarget && targetName) {
        highlighted = highlightSymbolInHtml(highlighted, targetName);
      }
      rows.push(
        `<div class="code-line${isTarget ? ' is-target' : ''}" data-line="${item.line}" data-column="${column}" title="打开第 ${item.line + 1} 行">` +
          `<span class="line-number">${item.line + 1}</span>` +
          `<span class="code-text">${marker}${highlighted}</span>` +
          '</div>',
      );
    }
    els.codeTable.innerHTML = rows.join('');
    els.codeScroll.hidden = false;

    window.requestAnimationFrame(() => {
      const target = els.codeTable.querySelector('.code-line.is-target');
      if (!target) {
        return;
      }
      els.codeScroll.scrollTop = Math.max(
        0,
        target.offsetTop - els.codeScroll.clientHeight * 0.28,
      );
    });
  }

  function highlightSymbolInHtml(html, name) {
    if (!html || !name) {
      return html;
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'g');
    const wrap = (text) => text.replace(
      pattern,
      (match) => `<span class="symbol-hit">${match}</span>`,
    );
    let result = '';
    let lastIndex = 0;
    const tags = /<[^>]*>/g;
    let tag;
    while ((tag = tags.exec(html)) !== null) {
      result += wrap(html.slice(lastIndex, tag.index));
      result += tag[0];
      lastIndex = tags.lastIndex;
    }
    result += wrap(html.slice(lastIndex));
    return result;
  }

  function contextNoticeText(context) {
    if (context.truncatedTop && context.truncatedBottom) {
      return `显示第 ${context.startLine + 1}–${context.endLine + 1} 行（上下方已省略）`;
    }
    if (context.truncatedTop) {
      return `上方已省略 · 从第 ${context.startLine + 1} 行开始`;
    }
    if (context.truncatedBottom) {
      return `下方已省略 · 显示到第 ${context.endLine + 1} 行 / 共 ${context.totalLines} 行`;
    }
    return '';
  }

  function fingerprintLines(lines) {
    let hash = 2166136261;
    for (const item of lines || []) {
      hash ^= item.line;
      hash = Math.imul(hash, 16777619);
      const text = item.text || '';
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    return (hash >>> 0).toString(36);
  }

  /* ------------------------------------------------------------- relation */

  function renderRelationTabs(relation) {
    const tabs = relation.tabs || [];
    els.relationTabList.innerHTML = tabs.map((tab) => (
      `<button class="relation-tab${tab.active ? ' is-active' : ''}" type="button" role="tab" aria-selected="${tab.active}" data-tab-id="${escapeAttr(tab.id)}" title="${escapeAttr(tab.label)}">` +
        `<span class="relation-tab-label">${escapeHtml(tab.label)}</span>` +
        (tabs.length > 1
          ? `<span class="relation-tab-close" data-close-tab="${escapeAttr(tab.id)}" title="关闭此视图">×</span>`
          : '') +
      '</button>'
    )).join('');
    els.newRelationTab.disabled = tabs.length >= 6;
  }

  function renderRelation(relation) {
    renderRelationTabs(relation);
    els.relationTitle.textContent = relation.rootName;
    els.relationTitle.title = relation.rootName;
    els.relationKindBadge.hidden = false;
    els.relationKindBadge.textContent = relation.rootKindLabel;
    els.relationLock.classList.toggle('is-active', relation.locked);
    els.relationLock.title = relation.locked ? 'Relation 已锁定' : '锁定 Relation';
    els.relationLock.setAttribute('aria-pressed', String(relation.locked));
    els.relationBack.disabled = !relation.canGoBack;
    els.relationForward.disabled = !relation.canGoForward;
    els.depthValue.textContent = String(relation.depth);
    els.depthMinus.disabled = relation.depth <= 1;
    els.depthPlus.disabled = relation.depth >= relation.maxDepth;
    els.relationCounts.textContent = countSummary(relation);
    els.relationSummary.textContent = countSummary(relation);

    for (const [value, button] of [
      ['horizontal', els.layoutHorizontal],
      ['vertical', els.layoutVertical],
      ['outline', els.layoutOutline],
    ]) {
      button.classList.toggle('is-active', layout === value);
      button.setAttribute('aria-pressed', String(layout === value));
    }

    const options = relation.availableModes
      .map((option) => `<option value="${escapeAttr(option.value)}"${option.value === relation.mode ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
      .join('');
    if (els.relationMode.dataset.options !== options) {
      els.relationMode.innerHTML = options;
      els.relationMode.dataset.options = options;
    }
    els.relationMode.disabled = relation.availableModes.length <= 1;

    renderWarnings(relation.warnings);
    els.relationFooter.hidden = false;
    els.graphScroll.hidden = false;
    const graph = relation.graph || {};
    els.tree.style.setProperty('--si-tree-gap', `${Number(graph.spacing) || 40}px`);
    els.tree.classList.toggle('no-shadow', graph.shadow === false);

    const identity = [relation.rootName, relation.mode, relation.depth].join(':');
    if (identity !== lastRelationIdentity) {
      lastRelationIdentity = identity;
      collapsedNodes.clear();
      deferredLoading.clear();
      selectedNodeId = '';
    }

    const fingerprint = relationFingerprint(relation);
    if (fingerprint !== lastRelationKey) {
      lastRelationKey = fingerprint;
      nodeMap = new Map();
      nodeMap.set(relation.root.id, relation.root);
      if (relation.declaration) {
        nodeMap.set(relation.declaration.id, relation.declaration);
      }
      for (const node of relation.left) {
        indexNodes(node);
      }
      for (const node of relation.right) {
        indexNodes(node);
      }
      renderRelationTree(relation);
    }
  }

  function countSummary(relation) {
    if (relation.mode === 'both') {
      return `调用者 ${relation.counts.callers} · 被调用 ${relation.counts.callees} · 节点 ${relation.totalNodes}`;
    }
    if (relation.mode === 'callees') {
      return `被调用 ${relation.counts.callees} · 节点 ${relation.totalNodes}`;
    }
    if (relation.mode === 'contains') {
      return `成员 ${relation.counts.members} · 节点 ${relation.totalNodes}`;
    }
    if (relation.mode === 'instances') {
      return `变量实例 ${relation.counts.instances || 0} · 节点 ${relation.totalNodes}`;
    }
    if (relation.mode === 'memberAccess') {
      return `成员访问 ${relation.counts.members} · 节点 ${relation.totalNodes}`;
    }
    if (relation.mode === 'declarations') {
      return `声明/定义 ${relation.counts.declarations || 0} · 节点 ${relation.totalNodes}`;
    }
    if (relation.mode === 'type') {
      return `类型关系 · 节点 ${relation.totalNodes}`;
    }
    if (relation.mode === 'callers') {
      return `调用者 ${relation.counts.callers} · 节点 ${relation.totalNodes}`;
    }
    return `引用 ${relation.counts.references} · 节点 ${relation.totalNodes}`;
  }

  function relationFingerprint(relation) {
    const parts = [
      layout,
      relation.mode,
      relation.depth,
      relation.root.id,
      [...collapsedNodes].sort().join(','),
      [...deferredLoading].sort().join(','),
    ];
    const walk = (node) => {
      parts.push(node.id, node.name, node.count || 0, node.children.length);
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(relation.root);
    if (relation.declaration) {
      parts.push(relation.declaration.id);
    }
    for (const node of relation.left) {
      walk(node);
    }
    for (const node of relation.right) {
      walk(node);
    }
    return parts.join('|');
  }

  function indexNodes(node) {
    nodeMap.set(node.id, node);
    for (const child of node.children) {
      indexNodes(child);
    }
  }

  function renderRelationTree(relation) {
    if (layout === 'outline') {
      els.tree.className = 'tree outline-layout';
      els.tree.innerHTML = renderOutline(relation);
    } else if (layout === 'vertical') {
      els.tree.className = 'tree vertical-layout';
      els.tree.innerHTML = renderVertical(relation);
    } else {
      els.tree.className = 'tree horizontal-layout' + (relation.mode === 'both' ? ' is-both' : '');
      els.tree.innerHTML = renderHorizontal(relation);
    }
    els.connectors.hidden = layout === 'outline';
    const graph = state.relation && state.relation.graph;
    els.tree.classList.toggle('no-shadow', Boolean(graph && graph.shadow === false));
    restoreSelection();
    scheduleConnectors();
  }

  function renderHorizontal(relation) {
    const left = relation.mode === 'both'
      ? `<div class="forest-col is-left" data-parent-id="root" data-side="left">${renderForest(relation.left, 'left')}</div>`
      : '';
    const declaration = relation.declaration ? declarationCard(relation.declaration) : '';
    const right = `<div class="forest-col is-right" data-parent-id="root" data-side="right">${declaration}${renderForest(relation.right, 'right')}</div>`;
    return `${left}<div class="root-col">${rootCard(relation.root)}</div>${right}`;
  }

  function renderVertical(relation) {
    const root = `<div class="root-col">${rootCard(relation.root)}</div>`;
    if (relation.mode === 'both') {
      return (
        root +
        '<div class="vertical-sections">' +
          `<section class="vertical-section"><div class="section-heading">调用者 <span>${relation.counts.callers}</span></div>${renderForest(relation.left, 'left')}</section>` +
          `<section class="vertical-section"><div class="section-heading">被调用 <span>${relation.counts.callees}</span></div>${relation.declaration ? declarationCard(relation.declaration) : ''}${renderForest(relation.right, 'right')}</section>` +
        '</div>'
      );
    }
    const declaration = relation.declaration ? declarationCard(relation.declaration) : '';
    return (
      root +
      '<div class="vertical-sections single">' +
        `<section class="vertical-section">${declaration}${renderForest(relation.right, 'right')}${relation.left.length ? renderForest(relation.left, 'left') : ''}</section>` +
      '</div>'
    );
  }

  function renderOutline(relation) {
    const declaration = relation.declaration
      ? outlineRow(relation.declaration, 0, 'declaration-row')
      : '';
    if (relation.mode === 'both') {
      return (
        `<div class="outline-root">${outlineRoot(relation.root)}</div>` +
        `<div class="outline-section-title">调用者</div>${renderOutlineNodes(relation.left, 0)}` +
        `<div class="outline-section-title">被调用</div>${declaration}${renderOutlineNodes(relation.right, 0)}`
      );
    }
    return (
      `<div class="outline-root">${outlineRoot(relation.root)}</div>` +
      declaration +
      renderOutlineNodes(relation.right, 0) +
      renderOutlineNodes(relation.left, 0)
    );
  }

  function renderOutlineNodes(nodes, depth) {
    return nodes.map((node) => {
      const children = collapsedNodes.has(node.id)
        ? ''
        : renderOutlineNodes(node.children, depth + 1);
      return outlineRow(node, depth) + children;
    }).join('');
  }

  function outlineRoot(root) {
    return (
      `<div class="outline-root-row" data-node-id="${escapeAttr(root.id)}" tabindex="0">` +
        '<span class="outline-glyph">◆</span>' +
        `<span class="outline-name">${escapeHtml(root.name)}</span>` +
        `<span class="outline-kind">${escapeHtml(root.kindLabel)}</span>` +
      '</div>'
    );
  }

  function outlineRow(node, depth, extraClass = '') {
    const collapsed = collapsedNodes.has(node.id);
    const hasChildren = node.children.length > 0;
    const chevron = hasChildren || node.expandable
      ? `<button class="outline-chevron${collapsed ? ' is-collapsed' : ''}" data-chevron-id="${escapeAttr(node.id)}" type="button" title="${collapsed ? '展开' : '收起'}">${collapsed ? '▸' : '▾'}</button>`
      : '<span class="outline-chevron-placeholder"></span>';
    const badges = nodeBadges(node);
    const sites = renderNodeSites(node);
    return (
      `<div class="outline-row ${extraClass}${collapsed ? ' is-collapsed' : ''}" style="--outline-depth:${depth}" data-wrap-id="${escapeAttr(node.id)}" data-node-id="${escapeAttr(node.id)}" tabindex="0">` +
        `<span class="outline-indent"></span>${chevron}` +
        `<span class="outline-glyph">${nodeGlyph(node)}</span>` +
        `<span class="outline-name">${escapeHtml(node.name)}</span>` +
        badges +
      '</div>' +
      (sites
        ? `<div class="outline-sites" style="--outline-depth:${depth}">${sites}</div>`
        : '')
    );
  }

  function rootCard(root) {
    const tags = Array.isArray(root.tags)
      ? root.tags
        .filter((tag) => tag !== '声明' && tag !== '定义')
        .map((tag) => `<span class="tag-badge">${escapeHtml(tag)}</span>`)
        .join('')
      : '';
    return (
      `<div class="root-card" data-node-id="${escapeAttr(root.id)}" tabindex="0" role="button" title="${escapeAttr(root.name)}">` +
        `<div class="root-eyebrow"><span class="root-role">${root.kindLabel === '搜索结果' ? '搜索' : '定义'}</span></div>` +
        `<div class="root-name">${nodeGlyph(root)}<span>${escapeHtml(root.name)}</span></div>` +
        `<div class="root-kind">${escapeHtml(root.kindLabel)}${tags ? `<span class="root-tags">${tags}</span>` : ''}</div>` +
      '</div>'
    );
  }

  function declarationCard(node) {
    return (
      `<div class="declaration-card" data-node-id="${escapeAttr(node.id)}" tabindex="0" role="button" title="${escapeAttr(node.name)}">` +
        '<span class="declaration-glyph">◇</span>' +
        `<span class="declaration-name">${escapeHtml(node.name)}</span>` +
        '<span class="mini-badge">声明</span>' +
      '</div>'
    );
  }

  function renderForest(nodes, side) {
    return nodes.map((node) => renderTreeNode(node, side)).join('');
  }

  function renderTreeNode(node, side) {
    const collapsed = collapsedNodes.has(node.id);
    const hasChildren = node.children.length > 0;
    const loading = deferredLoading.has(node.id);
    let chevron = '';
    if (hasChildren || node.expandable) {
      const glyph = loading ? '…' : collapsed ? '▸' : hasChildren ? '▾' : '+';
      chevron = `<button class="chevron${collapsed ? ' is-collapsed' : ''}${loading ? ' is-loading' : ''}" data-chevron-id="${escapeAttr(node.id)}" type="button" title="${collapsed ? '展开' : hasChildren ? '收起' : '展开'}">${glyph}</button>`;
    }
    const children = hasChildren
      ? `<div class="node-children" data-parent-id="${escapeAttr(node.id)}" data-side="${escapeAttr(side)}">${renderForest(node.children, side)}</div>`
      : '';
    return (
      `<div class="tree-node${collapsed ? ' is-collapsed' : ''}" data-wrap-id="${escapeAttr(node.id)}">` +
        `<div class="node-card role-${escapeAttr(node.role)}${node.cycle ? ' is-cycle' : ''}" data-node-id="${escapeAttr(node.id)}" tabindex="0" role="button" title="${escapeAttr(node.name)}">` +
          chevron +
          `<span class="node-glyph">${nodeGlyph(node)}</span>` +
          `<span class="node-main">` +
            `<span class="node-name">${escapeHtml(node.name)}</span>` +
            (node.locationLabel ? `<span class="node-location">${escapeHtml(node.locationLabel)}</span>` : '') +
            renderNodeSites(node) +
          '</span>' +
          nodeBadges(node, true) +
        '</div>' +
        children +
      '</div>'
    );
  }

  function renderNodeSites(node) {
    if (!Array.isArray(node.sites) || node.sites.length === 0) {
      return '';
    }
    const rows = node.sites.map((site, index) => {
      const role = site.role === 'call'
        ? '调用'
        : site.role === 'read'
          ? '读'
          : site.role === 'write'
            ? '写'
            : site.role === 'address'
              ? '取址'
              : '引用';
      return `<button class="node-site role-${escapeAttr(site.role)}" type="button" data-site-node-id="${escapeAttr(node.id)}" data-site-index="${index}" title="在 Context 中查看第 ${site.line} 行">` +
        `<span class="node-site-label">Line</span><span class="node-site-line">${site.line}</span><span class="node-site-role">${role}</span>` +
        '</button>';
    });
    return `<span class="node-sites">${rows.join('')}</span>`;
  }

  function nodeGlyph(node) {
    if (node.role === 'definition') {
      return '◆';
    }
    if (node.role === 'declaration') {
      return '◇';
    }
    if (node.role === 'type') {
      return 'T';
    }
    if (node.role === 'instance') {
      return (node.tags || []).some((tag) => tag.indexOf('指针') >= 0) ? '*' : 'S';
    }
    if (node.role === 'member') {
      return '·';
    }
    const kind = node.kindLabel || '';
    if (kind.indexOf('函数式宏') >= 0 || kind.indexOf('宏') >= 0) {
      return 'M';
    }
    if (kind.indexOf('结构体') >= 0) {
      return 'S';
    }
    if (kind.indexOf('联合体') >= 0) {
      return 'U';
    }
    if (kind.indexOf('枚举') >= 0) {
      return 'E';
    }
    if (kind.indexOf('别名') >= 0) {
      return 't';
    }
    if (kind.indexOf('汇编标签') >= 0) {
      return '@';
    }
    if (node.isFunction) {
      return 'ƒ';
    }
    if (node.isVariable) {
      return (node.tags || []).some((tag) => tag.indexOf('指针') >= 0) ? '*' : 'v';
    }
    return '·';
  }

  function nodeBadges(node, compact = false) {
    const parts = [];
    if (node.count && node.count > 1) {
      parts.push(`<span class="count-badge">×${node.count}</span>`);
    }
    if (node.readCount) {
      parts.push(`<span class="count-badge read">读×${node.readCount}</span>`);
    }
    if (node.writeCount) {
      parts.push(`<span class="count-badge write">写×${node.writeCount}</span>`);
    }
    if (node.cycle) {
      parts.push('<span class="cycle-badge">循环</span>');
    }
    if (!compact && node.role === 'declaration') {
      parts.push('<span class="mini-badge">声明</span>');
    }
    if (Array.isArray(node.tags)) {
      for (const tag of node.tags) {
        if (tag === '声明' || tag === '定义') {
          continue;
        }
        parts.push(`<span class="tag-badge">${escapeHtml(tag)}</span>`);
      }
    }
    if (parts.length === 0) {
      return '';
    }
    return `<span class="node-badges">${parts.join('')}</span>`;
  }

  function renderWarnings(warnings) {
    if (!warnings || warnings.length === 0) {
      els.relationWarnings.hidden = true;
      els.relationWarnings.innerHTML = '';
      return;
    }
    els.relationWarnings.hidden = false;
    els.relationWarnings.innerHTML =
      `<details class="warnings"><summary>⚠ ${warnings.length} 条提示</summary><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>`;
  }

  function restoreSelection() {
    if (!selectedNodeId) {
      return;
    }
    const node = els.tree.querySelector(`[data-node-id="${cssEscape(selectedNodeId)}"]`);
    if (node) {
      node.classList.add('is-selected');
    } else {
      selectedNodeId = '';
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------- connectors */

  function scheduleConnectors() {
    window.cancelAnimationFrame(connectorFrame);
    connectorFrame = window.requestAnimationFrame(drawConnectors);
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        window.cancelAnimationFrame(connectorFrame);
        connectorFrame = window.requestAnimationFrame(drawConnectors);
      });
      resizeObserver.observe(els.tree);
      resizeObserver.observe(els.graphScroll);
    }
  }

  function drawConnectors() {
    if (layout === 'outline' || els.graphScroll.hidden) {
      els.connectors.innerHTML = '';
      return;
    }
    const graph = (state.relation && state.relation.graph) || {};
    const lineStyle = graph.lineStyle || 'elbow';
    const arrows = graph.arrows !== false;
    const stageRect = els.graphStage.getBoundingClientRect();
    const width = Math.max(els.graphStage.scrollWidth, els.graphScroll.clientWidth);
    const height = Math.max(els.graphStage.scrollHeight, els.graphScroll.clientHeight);
    els.connectors.setAttribute('viewBox', `0 0 ${width} ${height}`);
    els.connectors.setAttribute('width', String(width));
    els.connectors.setAttribute('height', String(height));
    els.connectors.style.width = `${width}px`;
    els.connectors.style.height = `${height}px`;
    const parts = [];
    if (arrows) {
      parts.push(
        '<defs><marker id="si-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
          '<path d="M 0 0 L 8 4 L 0 8 Z" fill="currentColor" stroke="none"/>' +
        '</marker></defs>',
      );
    }
    const marker = arrows ? ' marker-end="url(#si-arrow)"' : '';

    const wrappers = els.tree.querySelectorAll('[data-parent-id]');
    for (const wrapper of wrappers) {
      const parentId = wrapper.dataset.parentId;
      const parent = els.tree.querySelector(`[data-node-id="${cssEscape(parentId)}"]`);
      if (!parent) {
        continue;
      }
      const side = wrapper.dataset.side || 'right';
      const parentRect = parent.getBoundingClientRect();
      const children = [...wrapper.children].filter((child) =>
        child.classList.contains('tree-node') || child.classList.contains('declaration-card'),
      );
      for (const child of children) {
        if (child.classList.contains('is-collapsed')) {
          continue;
        }
        const card = child.classList.contains('tree-node')
          ? child.querySelector(':scope > .node-card')
          : child;
        if (!card) {
          continue;
        }
        const childRect = card.getBoundingClientRect();
        if (childRect.width === 0 || childRect.height === 0) {
          continue;
        }
        if (layout === 'horizontal') {
          const isLeft = side === 'left';
          const x1 = (isLeft ? parentRect.left : parentRect.right) - stageRect.left;
          const y1 = parentRect.top + parentRect.height / 2 - stageRect.top;
          const x2 = (isLeft ? childRect.right : childRect.left) - stageRect.left;
          const y2 = childRect.top + childRect.height / 2 - stageRect.top;
          const midX = x1 + (isLeft ? -1 : 1) * Math.max(18, Math.min(52, Math.abs(x2 - x1) * 0.45));
          let path;
          if (lineStyle === 'direct') {
            path = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
          } else if (lineStyle === 'curve') {
            path = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${midX.toFixed(1)} ${y1.toFixed(1)}, ${midX.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
          } else {
            path = `M ${x1.toFixed(1)} ${y1.toFixed(1)} H ${midX.toFixed(1)} V ${y2.toFixed(1)} H ${x2.toFixed(1)}`;
          }
          parts.push(`<path d="${path}"${marker}/>`);
          if (!arrows) {
            parts.push(`<circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="2.2"/>`);
          }
        } else {
          const x1 = parentRect.left + parentRect.width / 2 - stageRect.left;
          const y1 = parentRect.bottom - stageRect.top;
          const x2 = childRect.left - stageRect.left;
          const y2 = childRect.top + childRect.height / 2 - stageRect.top;
          const midY = y1 + Math.max(12, Math.min(34, (y2 - y1) * 0.45));
          let path;
          if (lineStyle === 'direct') {
            path = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
          } else if (lineStyle === 'curve') {
            path = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${midY.toFixed(1)}, ${x2.toFixed(1)} ${midY.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
          } else {
            path = `M ${x1.toFixed(1)} ${y1.toFixed(1)} V ${midY.toFixed(1)} H ${x2.toFixed(1)} V ${y2.toFixed(1)}`;
          }
          parts.push(`<path d="${path}"${marker}/>`);
          if (!arrows) {
            parts.push(`<circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="2.2"/>`);
          }
        }
      }
    }
    els.connectors.innerHTML = parts.join('');
  }

  /* ------------------------------------------------------------- context menu */

  function openNodeMenu(node, clientX, clientY) {
    menuNodeId = node.id;
    els.nodeMenuTitle.textContent = node.name;
    const items = [];
    const add = (action, label, icon = '') => {
      items.push(`<button class="menu-item" type="button" data-menu-action="${action}" role="menuitem">${icon ? `<span class="menu-icon">${icon}</span>` : ''}<span>${label}</span></button>`);
    };
    const addExpand = (levels, label) => {
      items.push(`<button class="menu-item" type="button" data-menu-expand="${levels}" role="menuitem"><span class="menu-icon">+</span><span>${label}</span></button>`);
    };
    const kind = node.kindLabel || '';
    const hasSymbol = node.hasSymbol !== false;
    if (hasSymbol) {
      if (node.isFunction) {
        add('showCallers', '查看调用者', '←');
        add('showCallees', '查看被调用', '→');
        add('showReferences', '查看引用', '↗');
        add('showDeclarations', '查看声明/定义', '◇');
      } else if (kind.indexOf('宏') >= 0) {
        add('showReferences', '查看宏引用', '↗');
        add('showDeclarations', '查看宏定义', '◇');
      } else if (kind.indexOf('汇编标签') >= 0) {
        add('showCallers', '查看调用者', '←');
        add('showCallees', '查看被调用', '→');
        add('showReferences', '查看引用', '↗');
      } else if (node.isContainer) {
        add('showContains', '查看成员', '≡');
        if (kind.indexOf('枚举') < 0) {
          add('showInstances', '查看变量实例', 'v');
        }
        add('showDerived', '查看类型别名', '↳');
        add('showReferences', '查看引用', '↗');
        add('showDeclarations', '查看声明/定义', '◇');
      } else if (kind.indexOf('别名') >= 0) {
        add('showType', '查看目标类型', 'T');
        add('showContains', '查看成员', '≡');
        add('showInstances', '查看变量实例', 'v');
        add('showReferences', '查看引用', '↗');
      } else if (node.isVariable) {
        add('showReferences', '查看引用', '↗');
        add('showType', '查看类型', 'T');
        add('showMemberAccess', '查看成员访问', '.');
        add('showContains', '查看类型成员', '≡');
        add('showDeclarations', '查看声明/定义', '◇');
      } else {
        add('showReferences', '查看引用', '↗');
      }
      if (node.id !== 'root') {
        items.push('<div class="menu-separator"></div>');
        add('setRoot', '设为根节点', '◆');
        add('revealInContext', '在 Context 中查看', '▤');
      }
      if (node.expandable || node.children.length > 0) {
        items.push('<div class="menu-separator"></div>');
        addExpand(1, '展开一层');
        addExpand(2, '展开两层');
        addExpand(3, '展开三层');
      }
    }
    items.push('<div class="menu-separator"></div>');
    add('open', '打开定义', '↗');
    add('copy', '复制名称', '⧉');

    els.nodeMenuItems.innerHTML = items.join('');
    els.nodeMenu.hidden = false;
    const rect = els.nodeMenu.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(clientY, window.innerHeight - rect.height - 8);
    els.nodeMenu.style.left = `${Math.max(8, x)}px`;
    els.nodeMenu.style.top = `${Math.max(8, y)}px`;
  }

  function closeNodeMenu() {
    els.nodeMenu.hidden = true;
    menuNodeId = '';
  }

  /* ------------------------------------------------------------- syntax */

  const KEYWORDS = new Set([
    'abstract', 'alignas', 'alignof', 'and', 'as', 'asm', 'assert', 'async', 'auto', 'await',
    'bool', 'break', 'case', 'catch', 'char', 'char16_t', 'char32_t', 'class', 'concept',
    'const', 'consteval', 'constexpr', 'constinit', 'const_cast', 'continue', 'co_await',
    'co_return', 'co_yield', 'decltype', 'def', 'default', 'defer', 'del', 'delete', 'do',
    'double', 'dynamic_cast', 'elif', 'else', 'enum', 'except', 'explicit', 'export', 'extends',
    'extern', 'false', 'final', 'finally', 'float', 'for', 'from', 'friend', 'func', 'function',
    'go', 'goto', 'if', 'impl', 'implements', 'import', 'in', 'inline', 'instanceof', 'int',
    'interface', 'is', 'lambda', 'let', 'long', 'loop', 'match', 'module', 'move', 'mutable',
    'namespace', 'new', 'noexcept', 'not', 'nullptr', 'of', 'operator', 'or', 'override',
    'package', 'pass', 'private', 'protected', 'protocol', 'public', 'raise', 'readonly',
    'register', 'reinterpret_cast', 'require', 'return', 'sealed', 'short', 'signed', 'sizeof',
    'static', 'static_assert', 'static_cast', 'struct', 'super', 'switch', 'synchronized',
    'template', 'this', 'throw', 'throws', 'trait', 'transient', 'true', 'try', 'typealias',
    'typedef', 'typename', 'typeof', 'union', 'unsigned', 'unsafe', 'use', 'using', 'var',
    'virtual', 'void', 'volatile', 'where', 'while', 'with', 'yield',
  ]);
  const TYPES = new Set([
    'bool', 'boolean', 'byte', 'char', 'char8_t', 'char16_t', 'char32_t', 'double', 'float',
    'int', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'long', 'short', 'signed', 'size_t',
    'ssize_t', 'string', 'String', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'uint',
    'unsigned', 'void', 'wchar_t', 'UINT8', 'UINT16', 'UINT32', 'UINT64', 'INT8', 'INT16',
    'INT32', 'INT64', 'BOOL', 'BYTE', 'WORD', 'DWORD', 'HANDLE', 'std', 'auto',
  ]);
  const CONSTANTS = new Set([
    'true', 'false', 'null', 'NULL', 'undefined', 'None', 'True', 'False', 'nullptr',
    'TRUE', 'FALSE', 'NaN', 'Infinity',
  ]);

  function createHighlighter(languageId) {
    const language = String(languageId || '').toLowerCase();
    const python = language === 'python';
    let inBlockComment = false;
    let tripleQuote = '';
    return function highlight(line) {
      if (!line) {
        return '';
      }
      if (python) {
        return highlightPython(line);
      }
      if (/^(c|cpp|cuda-cpp|objective-c|objective-cpp|javascript|typescript|javascriptreact|typescriptreact|java|csharp|go|rust|swift|kotlin|php|scala|dart|json|jsonc)$/.test(language)) {
        return highlightCLike(line);
      }
      return escapeHtml(line);

      function highlightCLike(text) {
        const trimmed = text.trimStart();
        if (!inBlockComment && trimmed.startsWith('#')) {
          return `<span class="tok-preprocessor">${escapeHtml(text)}</span>`;
        }
        const out = [];
        let index = 0;
        while (index < text.length) {
          if (inBlockComment) {
            const close = text.indexOf('*/', index);
            if (close < 0) {
              out.push(`<span class="tok-comment">${escapeHtml(text.slice(index))}</span>`);
              return out.join('');
            }
            out.push(`<span class="tok-comment">${escapeHtml(text.slice(index, close + 2))}</span>`);
            index = close + 2;
            inBlockComment = false;
            continue;
          }
          const char = text[index];
          const next = text[index + 1];
          if (char === '/' && next === '/') {
            out.push(`<span class="tok-comment">${escapeHtml(text.slice(index))}</span>`);
            break;
          }
          if (char === '/' && next === '*') {
            inBlockComment = true;
            const close = text.indexOf('*/', index + 2);
            if (close < 0) {
              out.push(`<span class="tok-comment">${escapeHtml(text.slice(index))}</span>`);
              return out.join('');
            }
            out.push(`<span class="tok-comment">${escapeHtml(text.slice(index, close + 2))}</span>`);
            index = close + 2;
            inBlockComment = false;
            continue;
          }
          if (char === '"' || char === "'" || char === '`') {
            const quote = char;
            let cursor = index + 1;
            let escaped = false;
            while (cursor < text.length) {
              const current = text[cursor];
              if (escaped) {
                escaped = false;
              } else if (current === '\\') {
                escaped = true;
              } else if (current === quote) {
                cursor += 1;
                break;
              }
              cursor += 1;
            }
            out.push(`<span class="tok-string">${escapeHtml(text.slice(index, cursor))}</span>`);
            index = cursor;
            continue;
          }
          if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(next || ''))) {
            let cursor = index + 1;
            while (cursor < text.length && /[0-9a-fA-FxXoObB._']/.test(text[cursor])) {
              cursor += 1;
            }
            out.push(`<span class="tok-number">${escapeHtml(text.slice(index, cursor))}</span>`);
            index = cursor;
            continue;
          }
          if (/[A-Za-z_$]/.test(char)) {
            let cursor = index + 1;
            while (cursor < text.length && /[A-Za-z0-9_$]/.test(text[cursor])) {
              cursor += 1;
            }
            const word = text.slice(index, cursor);
            let restIndex = cursor;
            while (restIndex < text.length && /\s/.test(text[restIndex])) {
              restIndex += 1;
            }
            let className = '';
            if (KEYWORDS.has(word)) {
              className = 'tok-keyword';
            } else if (TYPES.has(word)) {
              className = 'tok-type';
            } else if (CONSTANTS.has(word)) {
              className = 'tok-constant';
            } else if (text[restIndex] === '(') {
              className = 'tok-function';
            }
            out.push(className ? `<span class="${className}">${escapeHtml(word)}</span>` : escapeHtml(word));
            index = cursor;
            continue;
          }
          out.push(escapeHtml(char));
          index += 1;
        }
        return out.join('');
      }

      function highlightPython(text) {
        const out = [];
        let index = 0;
        if (tripleQuote) {
          const close = text.indexOf(tripleQuote, index);
          if (close < 0) {
            out.push(`<span class="tok-string">${escapeHtml(text)}</span>`);
            return out.join('');
          }
          out.push(`<span class="tok-string">${escapeHtml(text.slice(index, close + 3))}</span>`);
          index = close + 3;
          tripleQuote = '';
        }
        while (index < text.length) {
          const char = text[index];
          if (char === '#') {
            out.push(`<span class="tok-comment">${escapeHtml(text.slice(index))}</span>`);
            break;
          }
          if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
            tripleQuote = text.slice(index, index + 3);
            const close = text.indexOf(tripleQuote, index + 3);
            if (close < 0) {
              out.push(`<span class="tok-string">${escapeHtml(text.slice(index))}</span>`);
              return out.join('');
            }
            out.push(`<span class="tok-string">${escapeHtml(text.slice(index, close + 3))}</span>`);
            index = close + 3;
            tripleQuote = '';
            continue;
          }
          if (char === '"' || char === "'") {
            let cursor = index + 1;
            let escaped = false;
            while (cursor < text.length) {
              const current = text[cursor];
              if (escaped) {
                escaped = false;
              } else if (current === '\\') {
                escaped = true;
              } else if (current === char) {
                cursor += 1;
                break;
              }
              cursor += 1;
            }
            out.push(`<span class="tok-string">${escapeHtml(text.slice(index, cursor))}</span>`);
            index = cursor;
            continue;
          }
          if (/[0-9]/.test(char)) {
            let cursor = index + 1;
            while (cursor < text.length && /[0-9a-fA-FxXoObB._]/.test(text[cursor])) {
              cursor += 1;
            }
            out.push(`<span class="tok-number">${escapeHtml(text.slice(index, cursor))}</span>`);
            index = cursor;
            continue;
          }
          if (/[A-Za-z_]/.test(char)) {
            let cursor = index + 1;
            while (cursor < text.length && /[A-Za-z0-9_]/.test(text[cursor])) {
              cursor += 1;
            }
            const word = text.slice(index, cursor);
            let restIndex = cursor;
            while (restIndex < text.length && /\s/.test(text[restIndex])) {
              restIndex += 1;
            }
            let className = '';
            if (KEYWORDS.has(word)) {
              className = 'tok-keyword';
            } else if (CONSTANTS.has(word)) {
              className = 'tok-constant';
            } else if (text[restIndex] === '(') {
              className = 'tok-function';
            }
            out.push(className ? `<span class="${className}">${escapeHtml(word)}</span>` : escapeHtml(word));
            index = cursor;
            continue;
          }
          out.push(escapeHtml(char));
          index += 1;
        }
        return out.join('');
      }
    };
  }

  /* ------------------------------------------------------------- layout */

  function setSplitRatio(ratio) {
    splitRatio = clamp(ratio, 0.28, 0.72);
    els.split.style.setProperty('--si-context-width', `${(splitRatio * 100).toFixed(3)}%`);
    saveUiState();
    scheduleConnectors();
  }

  function beginResize(event) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    document.body.classList.add('is-resizing');
    const bounds = els.split.getBoundingClientRect();
    const onMove = (moveEvent) => {
      setSplitRatio((moveEvent.clientX - bounds.left) / bounds.width);
    };
    const onUp = () => {
      document.body.classList.remove('is-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  function setLayout(next) {
    layout = next;
    saveUiState();
    if (state.relation) {
      renderRelation(state.relation);
    }
    scheduleConnectors();
  }

  function focusPane(pane) {
    const targetPane = pane === 'context' ? els.contextPane : els.relationPane;
    targetPane.classList.remove('is-focus-flash');
    void targetPane.offsetWidth;
    targetPane.classList.add('is-focus-flash');
    window.setTimeout(() => targetPane.classList.remove('is-focus-flash'), 900);
    targetPane.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (pane === 'context') {
      els.codeScroll.focus({ preventScroll: true });
    } else {
      const root = els.tree.querySelector('.root-card');
      if (root) {
        root.focus({ preventScroll: true });
      }
    }
  }

  /* ------------------------------------------------------------- events */

  els.refreshButton.addEventListener('click', () => post({ type: 'refresh' }));
  els.searchButton.addEventListener('click', () => post({ type: 'searchProject' }));
  els.indexButton.addEventListener('click', () => post({ type: 'rebuildIndex' }));
  els.settingsButton.addEventListener('click', () => post({ type: 'openSettings' }));
  els.relationRefreshButton.addEventListener('click', () => post({ type: 'refresh' }));
  els.newRelationTab.addEventListener('click', () => post({ type: 'newRelationTab' }));
  els.relationTabList.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-tab]');
    if (close) {
      event.preventDefault();
      event.stopPropagation();
      post({ type: 'closeRelationTab', tabId: close.dataset.closeTab });
      return;
    }
    const tab = event.target.closest('[data-tab-id]');
    if (tab) {
      post({ type: 'selectRelationTab', tabId: tab.dataset.tabId });
    }
  });
  els.followButton.addEventListener('click', () => post({ type: 'toggleFollow' }));
  els.emptyRefresh.addEventListener('click', () => post({ type: 'refresh' }));
  els.emptyFollow.addEventListener('click', () => post({ type: 'toggleFollow' }));
  els.contextLock.addEventListener('click', () => post({ type: 'toggleLock', pane: 'context' }));
  els.relationLock.addEventListener('click', () => post({ type: 'toggleLock', pane: 'relation' }));
  els.contextBack.addEventListener('click', () => post({ type: 'contextHistory', direction: 'back' }));
  els.contextForward.addEventListener('click', () => post({ type: 'contextHistory', direction: 'forward' }));
  els.relationBack.addEventListener('click', () => post({ type: 'relationHistory', direction: 'back' }));
  els.relationForward.addEventListener('click', () => post({ type: 'relationHistory', direction: 'forward' }));
  els.openContextButton.addEventListener('click', () => post({ type: 'openContext' }));
  els.gotoButton.addEventListener('click', () => post({ type: 'openContext' }));
  els.matchPrev.addEventListener('click', () => {
    if (state.context) {
      post({ type: 'selectMatch', index: Math.max(0, state.context.activeMatch - 1) });
    }
  });
  els.matchNext.addEventListener('click', () => {
    if (state.context) {
      post({ type: 'selectMatch', index: Math.min(state.context.matches.length - 1, state.context.activeMatch + 1) });
    }
  });
  els.copyContextButton.addEventListener('click', () => {
    if (state.context) {
      post({ type: 'copyText', text: state.context.symbolName });
      showToast(`已复制 ${state.context.symbolName}`);
    }
  });
  for (const view of ['definition', 'declaration', 'type']) {
    const button = $(`view-${view}`);
    button.addEventListener('click', () => post({ type: 'setContextView', view }));
  }
  els.depthMinus.addEventListener('click', () => {
    if (state.relation) {
      post({ type: 'setDepth', depth: Math.max(1, state.relation.depth - 1) });
    }
  });
  els.depthPlus.addEventListener('click', () => {
    if (state.relation) {
      post({ type: 'setDepth', depth: Math.min(state.relation.maxDepth, state.relation.depth + 1) });
    }
  });
  els.relationMode.addEventListener('change', () => {
    post({ type: 'setMode', mode: els.relationMode.value });
  });
  els.layoutHorizontal.addEventListener('click', () => setLayout('horizontal'));
  els.layoutVertical.addEventListener('click', () => setLayout('vertical'));
  els.layoutOutline.addEventListener('click', () => setLayout('outline'));
  els.expandAllButton.addEventListener('click', () => {
    if (state.relation) {
      collapsedNodes.clear();
      post({ type: 'setDepth', depth: state.relation.maxDepth });
    }
  });
  els.collapseAllButton.addEventListener('click', () => {
    if (!state.relation) {
      return;
    }
    const collect = (node) => {
      if (node.children.length > 0) {
        collapsedNodes.add(node.id);
        node.children.forEach(collect);
      }
    };
    state.relation.right.forEach(collect);
    state.relation.left.forEach(collect);
    renderRelation(state.relation);
  });

  els.splitter.addEventListener('pointerdown', beginResize);
  els.splitter.addEventListener('dblclick', () => setSplitRatio(0.49));
  els.splitter.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSplitRatio(splitRatio - 0.02);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSplitRatio(splitRatio + 0.02);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSplitRatio(0.49);
    }
  });

  els.codeTable.addEventListener('click', (event) => {
    const row = event.target.closest('.code-line');
    if (!row) {
      return;
    }
    post({ type: 'openContext', line: Number(row.dataset.line) });
  });

  els.tree.addEventListener('click', (event) => {
    const site = event.target.closest('[data-site-node-id]');
    if (site) {
      event.preventDefault();
      event.stopPropagation();
      const nodeId = site.dataset.siteNodeId || '';
      const card = site.closest('[data-node-id]');
      if (card) {
        selectedNodeId = nodeId;
        for (const selected of els.tree.querySelectorAll('.is-selected')) {
          selected.classList.remove('is-selected');
        }
        card.classList.add('is-selected');
      }
      post({
        type: 'previewNode',
        nodeId,
        siteIndex: Number(site.dataset.siteIndex || '0'),
      });
      return;
    }
    const chevron = event.target.closest('[data-chevron-id]');
    if (chevron) {
      event.preventDefault();
      event.stopPropagation();
      const id = chevron.dataset.chevronId;
      const node = nodeMap.get(id);
      if (!node) {
        return;
      }
      if (node.children.length === 0 && node.expandable) {
        deferredLoading.add(id);
        post({ type: 'requestExpand', nodeId: id, levels: 1 });
        if (state.relation) {
          renderRelation(state.relation);
        }
        return;
      }
      if (collapsedNodes.has(id)) {
        collapsedNodes.delete(id);
      } else {
        collapsedNodes.add(id);
      }
      if (state.relation) {
        renderRelation(state.relation);
      }
      return;
    }
    const card = event.target.closest('[data-node-id]');
    if (!card) {
      return;
    }
    selectedNodeId = card.dataset.nodeId || '';
    for (const selected of els.tree.querySelectorAll('.is-selected')) {
      selected.classList.remove('is-selected');
    }
    card.classList.add('is-selected');
    if (selectedNodeId !== 'root') {
      post({ type: 'previewNode', nodeId: selectedNodeId });
    }
  });

  els.tree.addEventListener('dblclick', (event) => {
    const site = event.target.closest('[data-site-node-id]');
    if (site) {
      event.preventDefault();
      event.stopPropagation();
      post({
        type: 'openNode',
        nodeId: site.dataset.siteNodeId || '',
        siteIndex: Number(site.dataset.siteIndex || '0'),
      });
      return;
    }
    const card = event.target.closest('[data-node-id]');
    if (!card) {
      return;
    }
    post({ type: 'openNode', nodeId: card.dataset.nodeId || '' });
  });

  els.tree.addEventListener('contextmenu', (event) => {
    const card = event.target.closest('[data-node-id]');
    if (!card) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const node = nodeMap.get(card.dataset.nodeId || '');
    if (!node) {
      return;
    }
    selectedNodeId = node.id;
    for (const selected of els.tree.querySelectorAll('.is-selected')) {
      selected.classList.remove('is-selected');
    }
    card.classList.add('is-selected');
    openNodeMenu(node, event.clientX, event.clientY);
  });

  els.tree.addEventListener('keydown', (event) => {
    const card = event.target.closest('[data-node-id]');
    if (!card) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      post({ type: 'openNode', nodeId: card.dataset.nodeId || '' });
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const node = nodeMap.get(card.dataset.nodeId || '');
      const rect = card.getBoundingClientRect();
      if (node) {
        openNodeMenu(node, rect.left + 12, rect.top + 12);
      }
    }
  });

  els.nodeMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-menu-action], [data-menu-expand]');
    if (!button) {
      return;
    }
    if (!menuNodeId) {
      return;
    }
    if (button.dataset.menuExpand) {
      const node = nodeMap.get(menuNodeId);
      const levels = Number(button.dataset.menuExpand);
      if (node && levels <= 1 && node.children.length > 0) {
        collapsedNodes.delete(menuNodeId);
        if (state.relation) {
          renderRelation(state.relation);
        }
      } else {
        collapsedNodes.delete(menuNodeId);
        post({
          type: 'requestExpand',
          nodeId: menuNodeId,
          levels,
        });
        deferredLoading.add(menuNodeId);
      }
    } else {
      post({
        type: 'nodeAction',
        nodeId: menuNodeId,
        action: button.dataset.menuAction,
      });
    }
    closeNodeMenu();
  });

  document.addEventListener('click', (event) => {
    if (!els.nodeMenu.hidden && !event.target.closest('#node-menu')) {
      closeNodeMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeNodeMenu();
      window.getSelection().removeAllRanges();
    }
  });
  els.graphScroll.addEventListener('scroll', closeNodeMenu, { passive: true });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'state') {
      const previousRelation = state.relation;
      state = message.state || state;
      if (
        previousRelation &&
        state.relation &&
        previousRelation.rootName === state.relation.rootName &&
        previousRelation.mode === state.relation.mode &&
        previousRelation.depth === state.relation.depth
      ) {
        // Preserve expansion state while refreshing the same tree.
      }
      if (state.relation) {
        deferredLoading.clear();
      }
      render();
      return;
    }
    if (message.type === 'focusPane') {
      focusPane(message.pane === 'relation' ? 'relation' : 'context');
      return;
    }
    if (message.type === 'cycleLayout') {
      setLayout(
        layout === 'horizontal'
          ? 'vertical'
          : layout === 'vertical'
            ? 'outline'
            : 'horizontal',
      );
    }
  });

  window.addEventListener('resize', scheduleConnectors);

  els.codeScroll.tabIndex = -1;
  setSplitRatio(splitRatio);
  render();
  post({ type: 'ready' });
})();
