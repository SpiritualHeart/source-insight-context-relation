import { fileNameFromUri } from './core';
import type {
  RelationCounts,
  RelationMode,
  RelationModeOption,
} from './protocol';
import type {
  BuildTreeOptions,
  HostNode,
  HostNodeSite,
  HostReference,
  HostRelationTree,
  HostSymbol,
  WorkspaceAnalyzerConfig,
} from './internal';
import { relationModeLabel } from './internal';
import type { SymbolService } from './symbolService';

interface BuildState {
  nodeMap: Map<string, HostNode>;
  nodeCount: number;
  truncated: boolean;
  warnings: Set<string>;
  expandedSymbols: Set<string>;
  options: BuildTreeOptions;
  showLocations: boolean;
}

export function availableModesFor(symbol: HostSymbol): RelationModeOption[] {
  if (symbol.isFunction) {
    return [
      { value: 'callers', label: '调用者', hint: '谁调用了当前函数' },
      { value: 'callees', label: '被调用', hint: '当前函数调用了谁' },
      { value: 'both', label: '双向', hint: '同时显示调用者与被调用者' },
      { value: 'references', label: '引用', hint: '所有引用位置' },
    ];
  }
  if (symbol.isContainer) {
    return [
      { value: 'contains', label: '成员', hint: '结构体/类/命名空间成员' },
      { value: 'derived', label: '派生', hint: '派生类型/实现' },
      { value: 'references', label: '引用', hint: '所有引用位置' },
    ];
  }
  if (symbol.isVariable) {
    return [
      { value: 'references', label: '引用', hint: '读取、写入和引用位置' },
      { value: 'type', label: '类型', hint: '变量的基类型/结构体类型' },
    ];
  }
  return [{ value: 'references', label: '引用', hint: '所有引用位置' }];
}

export function defaultModeFor(symbol: HostSymbol): RelationMode {
  if (symbol.isFunction) {
    return 'callers';
  }
  if (symbol.isContainer) {
    return 'contains';
  }
  if (symbol.isVariable) {
    return 'references';
  }
  return 'references';
}

export class RelationBuilder {
  constructor(
    private readonly service: SymbolService,
    private readonly getConfig: () => WorkspaceAnalyzerConfig,
  ) {}

  async build(
    root: HostSymbol,
    mode: RelationMode,
    depth: number,
    isStale: () => boolean,
  ): Promise<HostRelationTree> {
    const config = this.getConfig();
    const state: BuildState = {
      nodeMap: new Map(),
      nodeCount: 0,
      truncated: false,
      warnings: new Set(),
      expandedSymbols: new Set(),
      options: {
        mode,
        depth,
        expandDuplicateBranches: config.expandDuplicateBranches,
        excludeMacros: config.excludeMacros,
        excludedSymbols: config.excludedSymbols,
        maxNodes: config.maxRelationNodes,
      },
      showLocations: config.showLocations,
    };

    const rootNode = this.createNode(
      'root',
      'definition',
      root.name,
      root.kindLabel,
      root,
      root.definition,
      undefined,
      0,
      state,
    );
    rootNode.expandable = false;

    let declaration: HostNode | undefined;
    const declarationLocation = root.declaration
      ?? (root.isFunction ? root.definition : undefined);
    if (declarationLocation) {
      declaration = this.createNode(
        'decl',
        'declaration',
        root.name,
        root.kindLabel,
        root,
        declarationLocation,
        undefined,
        0,
        state,
      );
      declaration.expandable = false;
      if (root.isFunction && !root.declaration) {
        state.warnings.add('未找到独立的函数声明（原型），第一个关系节点使用定义位置。');
      }
    }

    const ancestors = new Set<string>([root.key]);
    let left: HostNode[] = [];
    let right: HostNode[] = [];
    if (mode === 'callers' || mode === 'references') {
      right = await this.buildCallerChildren(
        root,
        depth,
        ancestors,
        'r',
        rootNode,
        state,
        isStale,
        mode,
      );
    } else if (mode === 'callees') {
      right = await this.buildCalleeChildren(
        root,
        depth,
        ancestors,
        'r',
        rootNode,
        state,
        isStale,
      );
    } else if (mode === 'both') {
      left = await this.buildCallerChildren(
        root,
        depth,
        ancestors,
        'l',
        rootNode,
        state,
        isStale,
        'callers',
      );
      right = await this.buildCalleeChildren(
        root,
        depth,
        ancestors,
        'r',
        rootNode,
        state,
        isStale,
      );
    } else if (mode === 'contains') {
      right = await this.buildContainsChildren(
        root,
        depth,
        ancestors,
        'r',
        rootNode,
        state,
        isStale,
      );
    } else if (mode === 'derived') {
      right = await this.buildDerivedChildren(
        root,
        depth,
        ancestors,
        'r',
        rootNode,
        state,
        isStale,
      );
    } else if (mode === 'type') {
      right = await this.buildTypeChildren(
        root,
        depth,
        ancestors,
        'r',
        rootNode,
        state,
        isStale,
      );
    }

    if (right.length === 0 && left.length === 0) {
      state.warnings.add('未找到符合当前关系类型的节点。');
    }
    if (state.truncated) {
      state.warnings.add(
        `关系节点超过 ${state.options.maxNodes} 个，已截断。可减少层级或使用 Call Graph 过滤。`,
      );
    }

    const counts = countTree(left, right, state.nodeMap);
    return {
      root: rootNode,
      declaration,
      left,
      right,
      counts,
      warnings: [...state.warnings],
      nodeMap: state.nodeMap,
      mode,
      depth,
      totalNodes: state.nodeMap.size,
    };
  }

  async expandNode(
    tree: HostRelationTree,
    nodeId: string,
    levels: number,
    isStale: () => boolean,
  ): Promise<HostRelationTree> {
    const node = tree.nodeMap.get(nodeId);
    if (!node || !node.symbol || node.cycle) {
      return tree;
    }
    if (node.children.length > 0) {
      if (levels > 1) {
        for (const child of node.children) {
          if (child.symbol && !child.cycle) {
            await this.expandNode(tree, child.id, levels - 1, isStale);
          }
        }
      }
      return tree;
    }
    const state = this.stateForExpansion(tree);
    const ancestors = collectAncestorKeys(node);
    const effectiveMode = this.modeForNode(tree, node);
    let children: HostNode[] = [];
    if (effectiveMode === 'contains' || node.role === 'member' || node.role === 'type') {
      children = await this.buildContainsChildren(
        node.symbol,
        levels,
        ancestors,
        `${node.id}-c`,
        node,
        state,
        isStale,
      );
    } else if (effectiveMode === 'callees' || node.role === 'callee') {
      children = await this.buildCalleeChildren(
        node.symbol,
        levels,
        ancestors,
        `${node.id}-c`,
        node,
        state,
        isStale,
      );
    } else if (effectiveMode === 'derived' || node.role === 'derived') {
      children = await this.buildDerivedChildren(
        node.symbol,
        levels,
        ancestors,
        `${node.id}-c`,
        node,
        state,
        isStale,
      );
    } else {
      children = await this.buildCallerChildren(
        node.symbol,
        levels,
        ancestors,
        `${node.id}-c`,
        node,
        state,
        isStale,
        effectiveMode === 'references' ? 'references' : 'callers',
      );
    }
    node.children = children;
    node.expandable = children.length > 0 || hasExpansionPotential(node.symbol, effectiveMode);
    for (const child of children) {
      child.parent = node;
    }
    tree.counts = countTree(tree.left, tree.right, tree.nodeMap);
    tree.totalNodes = tree.nodeMap.size;
    if (state.truncated) {
      tree.warnings = [...new Set([...tree.warnings, '关系节点已达到上限，部分分支未展开。'])];
    }
    return tree;
  }

  private stateForExpansion(tree: HostRelationTree): BuildState {
    const config = this.getConfig();
    return {
      nodeMap: tree.nodeMap,
      nodeCount: tree.nodeMap.size,
      truncated: false,
      warnings: new Set(tree.warnings),
      expandedSymbols: new Set(
        [...tree.nodeMap.values()]
          .filter((node) => node.children.length > 0 && node.symbol)
          .map((node) => node.symbol!.key),
      ),
      options: {
        mode: tree.mode,
        depth: tree.depth,
        expandDuplicateBranches: config.expandDuplicateBranches,
        excludeMacros: config.excludeMacros,
        excludedSymbols: config.excludedSymbols,
        maxNodes: config.maxRelationNodes,
      },
      showLocations: config.showLocations,
    };
  }

  private modeForNode(tree: HostRelationTree, node: HostNode): RelationMode {
    if (tree.mode !== 'both') {
      return tree.mode;
    }
    if (node.role === 'callee') {
      return 'callees';
    }
    if (node.role === 'caller' || node.role === 'reference' || node.role === 'global') {
      return 'callers';
    }
    return tree.mode;
  }

  private async buildCallerChildren(
    symbol: HostSymbol,
    levels: number,
    ancestors: Set<string>,
    prefix: string,
    parent: HostNode,
    state: BuildState,
    isStale: () => boolean,
    mode: 'callers' | 'references',
  ): Promise<HostNode[]> {
    if (levels <= 0 || state.nodeCount >= state.options.maxNodes) {
      state.truncated = state.truncated || state.nodeCount >= state.options.maxNodes;
      return [];
    }
    const references = await this.service.getReferences(symbol, isStale);
    const filtered = references.filter((reference) => {
      if (reference.role === 'declaration') {
        return false;
      }
      if (state.options.excludedSymbols.includes(reference.callerName)) {
        return false;
      }
      if (mode === 'callers') {
        return reference.role === 'call';
      }
      return true;
    });
    const groups = groupReferences(filtered);
    const nodes: HostNode[] = [];
    let index = 0;
    for (const group of groups) {
      if (state.nodeCount >= state.options.maxNodes) {
        state.truncated = true;
        break;
      }
      const id = `${prefix}${index}`;
      index += 1;
      const caller = group.caller;
      const openLocation = group.sites[0]?.location
        ?? caller?.definition
        ?? group.references[0].location;
      const node = this.createNode(
        id,
        caller ? (group.calls > 0 ? 'caller' : 'reference') : 'global',
        caller?.name ?? '全局',
        caller?.kindLabel ?? '作用域',
        caller,
        openLocation,
        parent,
        parent.depth + 1,
        state,
        group.references.length,
      );
      node.readCount = group.reads;
      node.writeCount = group.writes;
      node.sites = group.sites;
      if (caller) {
        const cycle = ancestors.has(caller.key);
        node.cycle = cycle;
        // A macro reference is grouped by its owner (function/global
        // variable), but expanding that owner's callers would be misleading;
        // double-clicking the group already opens the macro use itself.
        node.expandable = !cycle && !(symbol.isMacro && mode === 'references');
        if (node.expandable && !cycle && levels > 1) {
          const duplicated = !state.options.expandDuplicateBranches &&
            state.expandedSymbols.has(caller.key);
          if (!duplicated) {
            state.expandedSymbols.add(caller.key);
            node.children = await this.buildCallerChildren(
              caller,
              levels - 1,
              new Set([...ancestors, caller.key]),
              `${id}-`,
              node,
              state,
              isStale,
              mode,
            );
          }
        }
      }
      nodes.push(node);
    }
    return nodes;
  }

  private async buildCalleeChildren(
    symbol: HostSymbol,
    levels: number,
    ancestors: Set<string>,
    prefix: string,
    parent: HostNode,
    state: BuildState,
    isStale: () => boolean,
  ): Promise<HostNode[]> {
    if (levels <= 0 || state.nodeCount >= state.options.maxNodes) {
      state.truncated = state.truncated || state.nodeCount >= state.options.maxNodes;
      return [];
    }
    const callees = await this.service.getCallees(symbol, isStale);
    const nodes: HostNode[] = [];
    let index = 0;
    for (const entry of callees) {
      if (state.nodeCount >= state.options.maxNodes) {
        state.truncated = true;
        break;
      }
      const target = entry.symbol;
      if (state.options.excludedSymbols.includes(target.name)) {
        continue;
      }
      const id = `${prefix}${index}`;
      index += 1;
      const node = this.createNode(
        id,
        'callee',
        target.name,
        target.kindLabel,
        target,
        target.definition,
        parent,
        parent.depth + 1,
        state,
        entry.count,
      );
      const cycle = ancestors.has(target.key);
      node.cycle = cycle;
      node.expandable = target.isFunction && !cycle;
      if (!cycle && levels > 1) {
        const duplicated = !state.options.expandDuplicateBranches &&
          state.expandedSymbols.has(target.key);
        if (!duplicated) {
          state.expandedSymbols.add(target.key);
          node.children = await this.buildCalleeChildren(
            target,
            levels - 1,
            new Set([...ancestors, target.key]),
            `${id}-`,
            node,
            state,
            isStale,
          );
        }
      }
      nodes.push(node);
    }
    return nodes;
  }

  private async buildContainsChildren(
    symbol: HostSymbol,
    levels: number,
    ancestors: Set<string>,
    prefix: string,
    parent: HostNode,
    state: BuildState,
    isStale: () => boolean,
  ): Promise<HostNode[]> {
    if (levels <= 0 || state.nodeCount >= state.options.maxNodes) {
      return [];
    }
    const members = await this.service.getMembers(symbol, isStale);
    const nodes: HostNode[] = [];
    let index = 0;
    for (const member of members) {
      if (state.nodeCount >= state.options.maxNodes) {
        state.truncated = true;
        break;
      }
      const id = `${prefix}${index}`;
      index += 1;
      const node = this.createNode(
        id,
        'member',
        member.name,
        member.kindLabel,
        member,
        member.definition,
        parent,
        parent.depth + 1,
        state,
      );
      if (member.isContainer) {
        const cycle = ancestors.has(member.key);
        node.cycle = cycle;
        node.expandable = !cycle;
        if (!cycle && levels > 1) {
          node.children = await this.buildContainsChildren(
            member,
            levels - 1,
            new Set([...ancestors, member.key]),
            `${id}-`,
            node,
            state,
            isStale,
          );
        }
      }
      nodes.push(node);
    }
    return nodes;
  }

  private async buildTypeChildren(
    symbol: HostSymbol,
    levels: number,
    ancestors: Set<string>,
    prefix: string,
    parent: HostNode,
    state: BuildState,
    isStale: () => boolean,
  ): Promise<HostNode[]> {
    const typeSymbol = await this.service.getType(symbol, isStale);
    if (!typeSymbol || state.nodeCount >= state.options.maxNodes) {
      state.warnings.add('未能解析变量的基类型。');
      return [];
    }
    const node = this.createNode(
      `${prefix}0`,
      'type',
      typeSymbol.name,
      typeSymbol.kindLabel,
      typeSymbol,
      typeSymbol.definition,
      parent,
      parent.depth + 1,
      state,
    );
    node.expandable = typeSymbol.isContainer;
    if (typeSymbol.isContainer && levels > 1) {
      node.children = await this.buildContainsChildren(
        typeSymbol,
        levels - 1,
        new Set([...ancestors, typeSymbol.key]),
        `${node.id}-c`,
        node,
        state,
        isStale,
      );
    }
    return [node];
  }

  private async buildDerivedChildren(
    symbol: HostSymbol,
    levels: number,
    ancestors: Set<string>,
    prefix: string,
    parent: HostNode,
    state: BuildState,
    isStale: () => boolean,
  ): Promise<HostNode[]> {
    if (levels <= 0 || state.nodeCount >= state.options.maxNodes) {
      return [];
    }
    const derived = await this.service.getDerived(symbol, isStale);
    if (derived.length === 0) {
      state.warnings.add('Language Server 未返回派生类型/实现关系。');
    }
    const nodes: HostNode[] = [];
    for (let index = 0; index < derived.length; index += 1) {
      if (state.nodeCount >= state.options.maxNodes) {
        state.truncated = true;
        break;
      }
      const entry = derived[index];
      const node = this.createNode(
        `${prefix}${index}`,
        'derived',
        entry.name,
        entry.kindLabel,
        entry,
        entry.definition,
        parent,
        parent.depth + 1,
        state,
      );
      const cycle = ancestors.has(entry.key);
      node.cycle = cycle;
      node.expandable = entry.isContainer && !cycle;
      if (!cycle && levels > 1) {
        node.children = await this.buildDerivedChildren(
          entry,
          levels - 1,
          new Set([...ancestors, entry.key]),
          `${node.id}-`,
          node,
          state,
          isStale,
        );
      }
      nodes.push(node);
    }
    return nodes;
  }

  private createNode(
    id: string,
    role: HostNode['role'],
    name: string,
    kindLabel: string,
    symbol: HostSymbol | undefined,
    openLocation: HostNode['openLocation'],
    parent: HostNode | undefined,
    depth: number,
    state: BuildState,
    count = 1,
  ): HostNode {
    const node: HostNode = {
      id,
      role,
      name,
      kindLabel,
      symbol,
      openLocation,
      count,
      readCount: 0,
      writeCount: 0,
      sites: [],
      children: [],
      expandable: false,
      cycle: false,
      locationLabel: state.showLocations
        ? `${fileNameFromUri(openLocation.uri)}:${openLocation.startLine + 1}`
        : undefined,
      depth,
      parent,
    };
    state.nodeMap.set(id, node);
    state.nodeCount += 1;
    return node;
  }
}

interface ReferenceGroup {
  caller?: HostSymbol;
  references: HostReference[];
  sites: HostNodeSite[];
  calls: number;
  reads: number;
  writes: number;
}

function groupReferences(references: HostReference[]): ReferenceGroup[] {
  const groups = new Map<string, ReferenceGroup>();
  for (const reference of references) {
    // Header declarations and source definitions can be different DocumentSymbol
    // records with the same function name. Group by logical symbol name/kind so
    // repeated use inside one function becomes one node with multiple line sites.
    const key = reference.caller
      ? `${reference.caller.isFunction ? 'function' : 'symbol'}:${reference.caller.name}`
      : 'global';
    let group = groups.get(key);
    if (!group) {
      group = {
        caller: reference.caller,
        references: [],
        sites: [],
        calls: 0,
        reads: 0,
        writes: 0,
      };
      groups.set(key, group);
    }
    group.references.push(reference);
    group.sites.push({
      location: reference.location,
      role: reference.role === 'declaration'
        ? 'reference'
        : reference.role,
    });
    if (reference.role === 'call') {
      group.calls += 1;
    } else if (reference.role === 'read') {
      group.reads += 1;
    } else if (reference.role === 'write') {
      group.writes += 1;
    }
  }
  for (const group of groups.values()) {
    group.sites.sort((a, b) => {
      if (a.location.uri !== b.location.uri) {
        return a.location.uri.localeCompare(b.location.uri);
      }
      if (a.location.startLine !== b.location.startLine) {
        return a.location.startLine - b.location.startLine;
      }
      return a.location.startCharacter - b.location.startCharacter;
    });
  }
  return [...groups.values()].sort((a, b) => {
    const nameA = a.caller?.name ?? '全局';
    const nameB = b.caller?.name ?? '全局';
    return nameA.localeCompare(nameB);
  });
}

function countTree(
  left: HostNode[],
  right: HostNode[],
  nodeMap: Map<string, HostNode>,
): RelationCounts {
  let callers = 0;
  let callees = 0;
  let references = 0;
  let members = 0;
  const roots = [...left, ...right];
  for (const node of roots) {
    if (node.role === 'caller') {
      callers += 1;
    } else if (node.role === 'callee') {
      callees += 1;
    } else if (node.role === 'member') {
      members += 1;
    } else if (node.role === 'reference' || node.role === 'global') {
      references += 1;
    }
  }
  return {
    callers,
    callees,
    references,
    members,
    total: nodeMap.size,
  };
}

function collectAncestorKeys(node: HostNode): Set<string> {
  const keys = new Set<string>();
  let current: HostNode | undefined = node;
  while (current) {
    if (current.symbol) {
      keys.add(current.symbol.key);
    }
    current = current.parent;
  }
  return keys;
}

function hasExpansionPotential(symbol: HostSymbol, mode: RelationMode): boolean {
  if (mode === 'contains' || mode === 'type') {
    return symbol.isContainer;
  }
  if (mode === 'derived') {
    return symbol.isContainer;
  }
  return symbol.isFunction;
}
