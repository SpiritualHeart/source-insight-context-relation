import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'),
  );
  const nonce = crypto.randomBytes(24).toString('base64');

  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Source Insight Context &amp; Relation</title>
</head>
<body>
  <div class="app-shell" id="app">
    <div class="loading-bar" id="loading-bar" aria-hidden="true"></div>

    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M2.5 3.5h4.2L8 5.7l1.3-2.2h4.2v3.1h-2.7L8 11.5 5.2 6.6H2.5z"/>
          </svg>
        </span>
        <span class="brand-title">Source Insight</span>
        <span class="brand-subtitle">Context &amp; Relation</span>
      </div>
      <div class="topbar-right">
        <span class="tracking-state" id="tracking-state" title="自动符号跟踪"></span>
        <div class="provider-state" id="provider-state" title="当前符号"></div>
        <button class="tool-button" id="follow-button" type="button" title="跟随编辑器光标" aria-pressed="true">
          <span class="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z"/>
              <circle cx="8" cy="8" r="2.1"/>
            </svg>
          </span>
          <span class="follow-label">跟随</span>
        </button>
        <button class="tool-button" id="refresh-button" type="button" title="重新分析当前符号">
          <span class="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M13.2 6.2A5.5 5.5 0 1 0 13 10.5"/>
              <path d="M13.2 2.8v3.4H9.8"/>
            </svg>
          </span>
          <span>刷新</span>
        </button>
      </div>
    </header>

    <main class="split" id="split">
      <section class="pane context-pane" id="context-pane" aria-label="Context 窗口">
        <div class="pane-head">
          <div class="pane-heading">
            <span class="pane-kicker">CONTEXT</span>
            <span class="pane-title" id="context-title">上下文</span>
            <span class="symbol-badge" id="kind-badge" hidden></span>
            <span class="context-file" id="context-file" hidden></span>
          </div>
          <div class="pane-head-meta">
            <span class="match-nav" id="match-nav" hidden>
              <button class="icon-button tiny" id="match-prev" type="button" title="上一个匹配">‹</button>
              <span id="match-label">1 / 1</span>
              <button class="icon-button tiny" id="match-next" type="button" title="下一个匹配">›</button>
            </span>
            <button class="icon-button" id="context-back" type="button" title="Context 后退">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9.8 3.2 5 8l4.8 4.8"/></svg>
            </button>
            <button class="icon-button" id="context-forward" type="button" title="Context 前进">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="m6.2 3.2 4.8 4.8-4.8 4.8"/></svg>
            </button>
            <button class="icon-button" id="context-lock" type="button" title="锁定 Context">
              <svg class="icon-lock" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="3.4" y="7" width="9.2" height="6.2" rx="1.3"/><path d="M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0V7"/>
              </svg>
            </button>
            <button class="icon-button" id="open-context-button" type="button" title="打开当前定义">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2">
                <path d="M6.2 3.2H3.4v9.4h9.4V9.8"/><path d="M9.2 2.9h4v4M13 3.1 7.8 8.3"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="context-viewbar" id="context-viewbar">
          <div class="segmented" role="group" aria-label="Context 内容">
            <button class="seg-button" id="view-definition" data-context-view="definition" type="button">定义</button>
            <button class="seg-button" id="view-declaration" data-context-view="declaration" type="button">声明</button>
            <button class="seg-button" id="view-type" data-context-view="type" type="button">类型</button>
          </div>
          <span class="type-name" id="type-name" hidden></span>
        </div>
        <div class="context-body" id="context-body">
          <div class="placeholder" id="context-placeholder"></div>
          <div class="code-scroll" id="code-scroll" hidden>
            <div class="code-notice" id="context-notice" hidden></div>
            <div class="code-table" id="code-table" role="table" aria-label="定义代码"></div>
          </div>
        </div>
        <footer class="pane-footer" id="context-footer" hidden>
          <span class="footer-summary" id="context-summary"></span>
          <span class="footer-spacer"></span>
          <button class="text-button" id="copy-context-button" type="button" title="复制符号名称">复制名称</button>
          <button class="text-button" id="goto-button" type="button">打开定义</button>
        </footer>
      </section>

      <div class="splitter" id="splitter" role="separator" aria-orientation="vertical" tabindex="0" title="拖动调整宽度">
        <span class="splitter-grip"></span>
      </div>

      <section class="pane relation-pane" id="relation-pane" aria-label="Relation 窗口">
        <div class="relation-tabs" id="relation-tabs">
          <div class="relation-tab-list" id="relation-tab-list" role="tablist" aria-label="Relation 视图"></div>
          <button class="relation-tab-add" id="new-relation-tab" type="button" title="新建 Relation 视图">+</button>
        </div>
        <div class="pane-head relation-head">
          <div class="pane-heading">
            <span class="pane-kicker">RELATION</span>
            <span class="pane-title" id="relation-title">关系</span>
            <span class="symbol-badge muted" id="relation-kind-badge" hidden></span>
          </div>
          <div class="pane-head-meta">
            <button class="icon-button" id="relation-back" type="button" title="Relation 后退">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9.8 3.2 5 8l4.8 4.8"/></svg>
            </button>
            <button class="icon-button" id="relation-forward" type="button" title="Relation 前进">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="m6.2 3.2 4.8 4.8-4.8 4.8"/></svg>
            </button>
            <button class="icon-button" id="relation-lock" type="button" title="锁定 Relation">
              <svg class="icon-lock" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="3.4" y="7" width="9.2" height="6.2" rx="1.3"/><path d="M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0V7"/>
              </svg>
            </button>
            <button class="icon-button" id="relation-refresh-button" type="button" title="刷新 Relation">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2">
                <path d="M13.2 6.2A5.5 5.5 0 1 0 13 10.5"/><path d="M13.2 2.8v3.4H9.8"/>
              </svg>
            </button>
            <div class="layout-group" role="group" aria-label="布局">
              <button class="icon-button layout-button" id="layout-horizontal" type="button" title="横向图">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="6.2" width="3.2" height="3.6" rx=".8"/><rect x="10.8" y="2.2" width="3.2" height="3.6" rx=".8"/><rect x="10.8" y="10.2" width="3.2" height="3.6" rx=".8"/><path d="M5.2 8h2.8V4h2.8M8 8v4h2.8"/></svg>
              </button>
              <button class="icon-button layout-button" id="layout-vertical" type="button" title="纵向图">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="6.2" y="2" width="3.6" height="3.2" rx=".8"/><rect x="2.2" y="10.8" width="3.6" height="3.2" rx=".8"/><rect x="10.2" y="10.8" width="3.6" height="3.2" rx=".8"/><path d="M8 5.2v2.8H4v2.8M8 8h4v2.8"/></svg>
              </button>
              <button class="icon-button layout-button" id="layout-outline" type="button" title="轮廓列表">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 4h1M6 4h7M5 8h1M8 8h5M5 12h1M8 12h5"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div class="relation-options">
          <label class="select-wrap" title="关系类型">
            <span class="option-label">关系</span>
            <select id="relation-mode"></select>
          </label>
          <div class="depth-control" title="自动展开层级">
            <span class="option-label">层级</span>
            <button class="icon-button tiny" id="depth-minus" type="button">−</button>
            <span class="depth-value" id="depth-value">1</span>
            <button class="icon-button tiny" id="depth-plus" type="button">+</button>
          </div>
          <div class="relation-counts" id="relation-counts"></div>
          <span class="footer-spacer"></span>
          <button class="text-button compact" id="expand-all-button" type="button" title="展开当前已加载的全部节点">展开</button>
          <button class="text-button compact" id="collapse-all-button" type="button" title="收起全部节点">收起</button>
        </div>
        <div class="relation-body" id="relation-body">
          <div class="placeholder" id="relation-placeholder"></div>
          <div class="graph-scroll" id="graph-scroll" hidden>
            <div class="graph-stage" id="graph-stage">
              <svg class="connectors" id="connectors" aria-hidden="true"></svg>
              <div class="tree" id="tree"></div>
            </div>
          </div>
          <div class="relation-warnings" id="relation-warnings" hidden></div>
        </div>
        <footer class="pane-footer" id="relation-footer" hidden>
          <span class="footer-summary" id="relation-summary"></span>
          <span class="footer-spacer"></span>
          <span class="footer-hint">双击跳转 · 右键关系菜单</span>
        </footer>
      </section>
    </main>

    <div class="empty-state" id="empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.4">
          <rect x="5" y="9" width="16" height="12" rx="2"/>
          <rect x="27" y="4" width="16" height="9" rx="2"/>
          <rect x="27" y="17" width="16" height="9" rx="2"/>
          <rect x="27" y="30" width="16" height="9" rx="2"/>
          <path d="M21 15h3v-6h3M24 15v-2.5h3M24 15v19.5h3"/>
        </svg>
      </div>
      <div class="empty-title" id="empty-title">把光标放在函数或变量上</div>
      <div class="empty-copy" id="empty-copy">
        点击编辑器中的符号，或按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>I</kbd>。
        Context 自动显示定义/声明，Relation 生成可调层级的调用树。
      </div>
      <div class="empty-actions">
        <button class="primary-button" id="empty-refresh" type="button">分析当前符号</button>
        <button class="secondary-button" id="empty-follow" type="button">开启光标跟随</button>
      </div>
      <div class="empty-note" id="empty-note"></div>
    </div>
  </div>

  <div class="node-menu" id="node-menu" hidden role="menu">
    <div class="node-menu-title" id="node-menu-title"></div>
    <div class="node-menu-items" id="node-menu-items"></div>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script nonce="${nonce}">
    (function () {
      function reportError(title, detail) {
        try {
          var existing = document.getElementById('boot-error');
          if (!existing) {
            existing = document.createElement('div');
            existing.id = 'boot-error';
            existing.className = 'boot-error';
            document.body.appendChild(existing);
          }
          existing.textContent = title + (detail ? '\\n' + detail : '');
        } catch (_) {
          // Nothing else we can do if the DOM is unavailable.
        }
      }
      window.addEventListener('error', function (event) {
        var target = event.target;
        if (target && target.tagName === 'SCRIPT') {
          reportError('Source Insight webview script failed to load', target.src);
        } else {
          reportError(
            'Source Insight webview error',
            (event.message || '') + (event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : '')
          );
        }
      }, true);
      window.addEventListener('unhandledrejection', function (event) {
        reportError('Source Insight webview promise rejection', String(event.reason));
      });
    })();
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
