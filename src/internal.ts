import type {
  ContextLine,
  ContextMatchView,
  ContextViewKind,
  RelationCounts,
  RelationMode,
  RelationRole,
  SourceLocation,
} from './protocol';

/** Internal, non-serializable rich symbol model. */
export interface HostSymbol {
  key: string;
  name: string;
  kindId: string;
  kindLabel: string;
  isFunction: boolean;
  isVariable: boolean;
  isContainer: boolean;
  isMacro: boolean;
  languageId: string;
  definition: SourceLocation;
  declaration?: SourceLocation;
  fullRange?: {
    startLine: number;
    endLine: number;
  };
  detail?: string;
}

export type HostReferenceRole = 'call' | 'read' | 'write' | 'reference' | 'declaration';

export interface HostReference {
  location: SourceLocation;
  role: HostReferenceRole;
  lineText: string;
  caller?: HostSymbol;
  callerName: string;
}

export interface HostNodeSite {
  location: SourceLocation;
  role: Exclude<HostReferenceRole, 'declaration'>;
}

export interface HostNode {
  id: string;
  role: RelationRole;
  name: string;
  kindLabel: string;
  symbol?: HostSymbol;
  openLocation: SourceLocation;
  count: number;
  readCount: number;
  writeCount: number;
  /** Distinct use/call sites grouped into this node, sorted by line. */
  sites: HostNodeSite[];
  children: HostNode[];
  expandable: boolean;
  cycle: boolean;
  locationLabel?: string;
  depth: number;
  parent?: HostNode;
}

export interface HostRelationTree {
  root: HostNode;
  declaration?: HostNode;
  left: HostNode[];
  right: HostNode[];
  counts: RelationCounts;
  warnings: string[];
  nodeMap: Map<string, HostNode>;
  mode: RelationMode;
  depth: number;
  /** Total nodes before truncation. */
  totalNodes: number;
}

export interface ContextFocus {
  /** Document location used to center the context window. */
  location: SourceLocation;
  /** Symbol highlighted at that location (the relation root). */
  targetName: string;
  /** Exact word range of the highlighted symbol; defaults to location. */
  targetLocation?: SourceLocation;
}

export interface HostContext {
  symbol: HostSymbol;
  targetName: string;
  /** Actual document shown by the context window. */
  fileUri: string;
  /** Set when the context was opened from a relation use/call site. */
  focusLocation?: SourceLocation;
  matches: ContextMatchView[];
  activeMatch: number;
  activeView: ContextViewKind;
  availableViews: ContextViewKind[];
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
  languageId: string;
  typeSymbol?: HostSymbol;
  notice?: string;
}

export interface ContextHistoryEntry {
  symbol: HostSymbol;
  view: ContextViewKind;
}

export interface RelationHistoryEntry {
  root: HostSymbol;
  mode: RelationMode;
  depth: number;
}

export interface WorkspaceAnalyzerConfig {
  contextLines: number;
  maxContextLines: number;
  maxReferences: number;
  maxRelationNodes: number;
  providerTimeoutMs: number;
  sortReferencesByFile: boolean;
  excludeMacros: boolean;
  excludedSymbols: string[];
  showLocations: boolean;
  expandDuplicateBranches: boolean;
  contextLineNumbers: boolean;
  relationLineStyle: 'elbow' | 'curve' | 'direct';
  relationSpacing: number;
  relationArrows: boolean;
  relationNodeShadow: boolean;
}

export interface BuildTreeOptions {
  mode: RelationMode;
  depth: number;
  expandDuplicateBranches: boolean;
  excludeMacros: boolean;
  excludedSymbols: string[];
  maxNodes: number;
}

export function relationModeLabel(mode: RelationMode): string {
  switch (mode) {
    case 'callers':
      return '调用者';
    case 'callees':
      return '被调用';
    case 'both':
      return '调用者 / 被调用';
    case 'contains':
      return '成员';
    case 'type':
      return '类型';
    case 'derived':
      return '派生类型';
    default:
      return '引用';
  }
}
