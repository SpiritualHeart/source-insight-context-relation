/** Serializable data shared by the extension host and the webview. */

export interface SourceLocation {
  uri: string;
  /** All line/character values are zero based, like the VS Code API. */
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export type ContextViewKind = 'definition' | 'declaration' | 'type';

export interface ContextLine {
  /** Zero based document line. */
  line: number;
  text: string;
}

export interface ContextMatchView {
  index: number;
  label: string;
  kindLabel: string;
  detail?: string;
}

export interface ContextView {
  symbolName: string;
  targetName: string;
  /** File displayed by the context window. */
  fileName: string;
  filePath?: string;
  kindLabel: string;
  isFunction: boolean;
  languageId: string;
  matches: ContextMatchView[];
  activeMatch: number;
  availableViews: ContextViewKind[];
  activeView: ContextViewKind;
  lines: ContextLine[];
  startLine: number;
  endLine: number;
  targetStartLine: number;
  targetEndLine: number;
  targetStartCharacter: number;
  targetEndCharacter: number;
  truncatedTop: boolean;
  truncatedBottom: boolean;
  totalLines: number;
  typeName?: string;
  showLineNumbers: boolean;
  locked: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  notice?: string;
}

export interface RelationGraphOptions {
  lineStyle: 'elbow' | 'curve' | 'direct';
  spacing: number;
  arrows: boolean;
  shadow: boolean;
}

export interface RelationTabView {
  id: string;
  label: string;
  active: boolean;
}

export type RelationMode =
  | 'references'
  | 'callers'
  | 'callees'
  | 'both'
  | 'contains'
  | 'type'
  | 'derived'
  | 'instances'
  | 'memberAccess'
  | 'declarations';

export interface RelationModeOption {
  value: RelationMode;
  label: string;
  hint?: string;
}

export type RelationRole =
  | 'definition'
  | 'declaration'
  | 'caller'
  | 'callee'
  | 'reference'
  | 'member'
  | 'type'
  | 'derived'
  | 'instance'
  | 'global';

export type ReferenceSiteRole = 'call' | 'read' | 'write' | 'address' | 'reference';

export interface RelationNodeSiteView {
  /** One-based line number at the use/call site. */
  line: number;
  role: ReferenceSiteRole;
}

export interface RelationNodeView {
  id: string;
  name: string;
  role: RelationRole;
  kindLabel: string;
  /** Number of grouped reference/call sites; omitted when 1. */
  count?: number;
  readCount?: number;
  writeCount?: number;
  /** Distinct use/call sites within this grouped node. */
  sites?: RelationNodeSiteView[];
  /** True when the node can be expanded, either immediately or by loading more. */
  expandable: boolean;
  isFunction?: boolean;
  isContainer?: boolean;
  isVariable?: boolean;
  /** Short attribute chips such as 指针 / 数组 / 宏 / extern / 原型. */
  tags?: string[];
  /** False for synthetic nodes (for example project search results). */
  hasSymbol?: boolean;
  /** Optional location column; hidden by default per Source Insight-style clean view. */
  locationLabel?: string;
  children: RelationNodeView[];
}

export interface RelationCounts {
  callers: number;
  callees: number;
  references: number;
  members: number;
  instances?: number;
  declarations?: number;
  total: number;
}

export interface RelationView {
  root: RelationNodeView;
  declaration?: RelationNodeView;
  /** Callers side for 'both'; empty for other modes. */
  left: RelationNodeView[];
  /** Main relation side (or callees for 'both'). */
  right: RelationNodeView[];
  mode: RelationMode;
  modeLabel: string;
  availableModes: RelationModeOption[];
  depth: number;
  maxDepth: number;
  rootName: string;
  rootKindLabel: string;
  isFunction: boolean;
  counts: RelationCounts;
  totalNodes: number;
  warnings: string[];
  locked: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  showLocations: boolean;
  graph: RelationGraphOptions;
  tabs: RelationTabView[];
  activeTabId: string;
}

export type PanelStatus = 'empty' | 'loading' | 'ready' | 'error';
export type TrackingMode = 'symbol' | 'enclosing' | 'off';

export interface PanelState {
  revision: number;
  status: PanelStatus;
  loading: boolean;
  followCursor: boolean;
  trackingMode: TrackingMode;
  autoReveal: boolean;
  context?: ContextView;
  relation?: RelationView;
  error?: string;
  notice?: string;
  updatedAt: number;
}

export type NodeAction =
  | 'showCallers'
  | 'showCallees'
  | 'showReferences'
  | 'showType'
  | 'showContains'
  | 'showDerived'
  | 'showInstances'
  | 'showMemberAccess'
  | 'showDeclarations'
  | 'setRoot'
  | 'expand'
  | 'collapse'
  | 'open'
  | 'copy'
  | 'revealInContext';

export interface OpenNodeMessage {
  type: 'openNode';
  nodeId: string;
  /** Zero-based index into RelationNodeView.sites. */
  siteIndex?: number;
}

export interface PreviewNodeMessage {
  type: 'previewNode';
  nodeId: string;
  /** Preview the declaration/type view instead of the definition. */
  view?: ContextViewKind;
  /** Zero-based index into RelationNodeView.sites. */
  siteIndex?: number;
}

export interface NodeActionMessage {
  type: 'nodeAction';
  nodeId: string;
  action: NodeAction;
  levels?: number;
}

export interface OpenContextMessage {
  type: 'openContext';
  line?: number;
}

export interface SetModeMessage {
  type: 'setMode';
  mode: RelationMode;
}

export interface SetDepthMessage {
  type: 'setDepth';
  depth: number;
}

export interface SelectMatchMessage {
  type: 'selectMatch';
  index: number;
}

export interface SetContextViewMessage {
  type: 'setContextView';
  view: ContextViewKind;
}

export interface ContextHistoryMessage {
  type: 'contextHistory';
  direction: 'back' | 'forward';
}

export interface RelationHistoryMessage {
  type: 'relationHistory';
  direction: 'back' | 'forward';
}

export interface ToggleLockMessage {
  type: 'toggleLock';
  pane: 'context' | 'relation';
}

export interface RequestExpandMessage {
  type: 'requestExpand';
  nodeId: string;
  levels?: number;
}

export interface LayoutMessage {
  type: 'setLayout';
  layout: 'horizontal' | 'vertical' | 'outline';
}

export interface NewRelationTabMessage {
  type: 'newRelationTab';
}

export interface CloseRelationTabMessage {
  type: 'closeRelationTab';
  tabId: string;
}

export interface SelectRelationTabMessage {
  type: 'selectRelationTab';
  tabId: string;
}

export interface RefreshMessage {
  type: 'refresh';
}

export interface SearchProjectMessage {
  type: 'searchProject';
}

export interface RebuildIndexMessage {
  type: 'rebuildIndex';
}

export interface OpenSettingsMessage {
  type: 'openSettings';
}

export interface ToggleFollowMessage {
  type: 'toggleFollow';
}

export interface FocusPaneMessage {
  type: 'focusPane';
  pane: 'context' | 'relation';
}

export interface CopyTextMessage {
  type: 'copyText';
  text: string;
}

export interface ReadyMessage {
  type: 'ready';
}

export type WebviewMessage =
  | OpenNodeMessage
  | PreviewNodeMessage
  | NodeActionMessage
  | OpenContextMessage
  | SetModeMessage
  | SetDepthMessage
  | SelectMatchMessage
  | SetContextViewMessage
  | ContextHistoryMessage
  | RelationHistoryMessage
  | ToggleLockMessage
  | RequestExpandMessage
  | LayoutMessage
  | NewRelationTabMessage
  | CloseRelationTabMessage
  | SelectRelationTabMessage
  | RefreshMessage
  | SearchProjectMessage
  | RebuildIndexMessage
  | OpenSettingsMessage
  | ToggleFollowMessage
  | FocusPaneMessage
  | CopyTextMessage
  | ReadyMessage;

export interface HostFocusPaneMessage {
  type: 'focusPane';
  pane: 'context' | 'relation';
}

export interface HostStateMessage {
  type: 'state';
  state: PanelState;
}

export interface HostCycleLayoutMessage {
  type: 'cycleLayout';
}

export type HostMessage = HostStateMessage | HostFocusPaneMessage | HostCycleLayoutMessage;
