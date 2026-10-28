import { fileNameFromUri, locationsEqual, normalizeUriForComparison } from './core';
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
  if (symbol.isLabel) {
    return [
      { value: 'callers', label: '调用者', hint: '哪些汇编标签跳转到此标签' },
      { value: 'callees', label: '被调用', hint: '当前标签调用了哪些标签' },
      { value: 'references', label: '引用', hint: '所有引用位置' },
      { value: 'declarations', label: '声明', hint: '标签定义与 .global 声明' },
    ];
  }
  if (symbol.isFunction) {
    return [
      { value: 'callers', label: '调用者', hint: '谁调用了当前函数' },
      { value: 'callees', label: '被调用', hint: '当前函数调用了谁（含函数式宏）' },
      { value: 'both', label: '双向', hint: '同时显示调用者与被调用者' },
      { value: 'references', label: '引用', hint: '所有引用位置（调用/读/写/取址）' },
      { value: 'declarations', label: '声明', hint: '函数原型与定义位置' },
    ];
  }
  if (symbol.isMacro) {
    return [
      { value: 'references', label: '引用', hint: '宏被使用的位置（不含 #define 本身）' },
      { value: 'declarations', label: '定义', hint: '#define 定义位置' },
    ];
  }
  if (symbol.isEnum && !symbol.isContainer) {
    return [
      { value: 'references', label: '引用', hint: '枚举常量的使用位置' },
      { value: 'declarations', label: '声明', hint: '枚举常量在枚举中的位置' },
    ];
  }
  if (symbol.isContainer) {
    if (symbol.isEnum) {
      return [
        { value: 'contains', label: '枚举成员', hint: '枚举常量列表' },
        { value: 'references', label: '引用', hint: '类型与成员的使用位置' },
        { value: 'declarations', label: '声明', hint: '前置声明与定义位置' },
      ];
    }
    return [
      { value: 'contains', label: '成员', hint: '结构体/联合体字段列表' },
      { value: 'instances', label: '变量实例', hint: '按值实例与指针实例' },
      { value: 'references', label: '引用', hint: '类型的使用位置' },
      { value: 'derived', label: '类型别名', hint: '指向此类型的 typedef' },
      { value: 'declarations', label: '声明', hint: '前置声明与定义位置' },
    ];
  }
  if (symbol.isTypedef) {
    return [
      { value: 'type', label: '目标类型', hint: 'typedef 指向的结构体/基础类型' },
      { value: 'contains', label: '成员', hint: '目标结构体的成员' },
      { value: 'instances', label: '变量实例', hint: '使用此别名声明的变量' },
      { value: 'references', label: '引用', hint: '类型别名的使用位置' },
    ];
  }
  if (symbol.isVariable) {
    const modes: RelationModeOption[] = [
      { value: 'references', label: '引用', hint: '读取、写入、取址和成员访问位置' },
      { value: 'type', label: '类型', hint: '变量的结构体/typedef 类型' },
    ];
    if (symbol.cKind !== 'field') {
      modes.push(
        { value: 'memberAccess', label: '成员访问', hint: '该变量实际访问的字段（区分 . 和 ->）' },
        { value: 'contains', label: '类型成员', hint: '类型声明的全部字段' },
      );
    }
    modes.push({ value: 'declarations', label: '声明', hint: 'extern 声明与定义位置' });
    return modes;
  }
  return [{ value: 'references', label: '引用', hint: '所有引用位置' }];
}

export function defaultModeFor(symbol: HostSymbol): RelationMode {
  if (symbol.isFunction || symbol.isLabel) {
    return 'callers';
  }
  if (symbol.isMacro) {
    return 'references';
  }
  if (symbol.isContainer) {
    return 'contains';
  }
  if (symbol.isTypedef) {
    return 'type';
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
    if (root.declaration && !locationsEqual(root.declaration, root.definition)) {
      declaration = this.createNode(
        'decl',
        'declaration',
        root.name,
        root.kindLabel,
        root,
        root.declaration,
        undefined,
        0,
        state,
      );
      declaration.expandable = false;
      declaration.tags = ['声明'];
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
    } else if (mode === 'instances') {
      right = await this.buildInstanceChildren(root, rootNode, state);
    } else if (mode === 'memberAccess') {
      right = await this.buildMemberUseChildren(root, rootNode, state);
    } else if (mode === 'declarations') {
      right = await this.buildDeclarationChildren(root, rootNode, state);
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
        caller ? (group.calls > 0 && symbol.isFunction ? 'caller' : 'reference') : 'global',
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

  private async buildInstanceChildren(
    symbol: HostSymbol,
    parent: HostNode,
    state: BuildState,
  ): Promise<HostNode[]> {
    const instances = await this.service.getInstances(symbol);
    if (instances.length === 0) {
      state.warnings.add('未找到该类型的变量实例。');
      return [];
    }
    const nodes: HostNode[] = [];
    for (let index = 0; index < instances.length; index += 1) {
      if (state.nodeCount >= state.options.maxNodes) {
        state.truncated = true;
        break;
      }
      const entry = instances[index];
      const node = this.createNode(
        `i${index}`,
        'instance',
        entry.symbol.name,
        entry.symbol.kindLabel,
        entry.symbol,
        entry.symbol.definition,
        parent,
        parent.depth + 1,
        state,
      );
      node.tags = [
        entry.isPointer ? '指针实例' : '值实例',
        ...(entry.isField ? ['字段'] : []),
        ...(entry.symbol.tags ?? []).filter((tag) => tag !== '指针' && tag !== '指针实例'),
      ];
      node.expandable = false;
      nodes.push(node);
    }
    return nodes;
  }

  private async buildMemberUseChildren(
    symbol: HostSymbol,
    parent: HostNode,
    state: BuildState,
  ): Promise<HostNode[]> {
    const uses = await this.service.getMemberUses(symbol);
    if (uses.length === 0) {
      state.warnings.add('未找到该变量的成员访问（. / ->）。');
      return [];
    }
    const nodes: HostNode[] = [];
    for (let index = 0; index < uses.length; index += 1) {
      if (state.nodeCount >= state.options.maxNodes) {
        state.truncated = true;
        break;
      }
      const entry = uses[index];
      const openLocation = entry.sites[0]?.location ?? entry.field?.definition;
      if (!openLocation) {
        continue;
      }
      const node = this.createNode(
        `m${index}`,
        'member',
        entry.member,
        `${entry.operator === '->' ? '指针访问' : '值访问'} · ${entry.field?.kindLabel ?? '字段'}`,
        entry.field,
        openLocation,
        parent,
        parent.depth + 1,
        state,
        entry.sites.length,
      );
      node.sites = entry.sites.map((site) => ({
        location: site.location,
        role: site.role,
      }));
      node.siteName = entry.member;
      node.readCount = entry.sites.filter((site) => site.role === 'read').length;
      node.writeCount = entry.sites.filter((site) => site.role === 'write').length;
      node.tags = [entry.operator === '->' ? '->' : '.', ...(entry.field?.tags ?? [])];
      node.expandable = false;
      nodes.push(node);
    }
    return nodes;
  }

  private async buildDeclarationChildren(
    symbol: HostSymbol,
    parent: HostNode,
    state: BuildState,
  ): Promise<HostNode[]> {
    const entries = await this.service.getDeclarationSites(symbol);
    const nodes: HostNode[] = [];
    if (entries.length === 0) {
      const node = this.createNode(
        'd0',
        'declaration',
        symbol.name,
        `${symbol.kindLabel} · 定义`,
        symbol,
        symbol.definition,
        parent,
        parent.depth + 1,
        state,
      );
      node.tags = ['定义'];
      node.expandable = false;
      nodes.push(node);
      return nodes;
    }
    for (let index = 0; index < entries.length; index += 1) {
      if (state.nodeCount >= state.options.maxNodes) {
        state.truncated = true;
        break;
      }
      const entry = entries[index];
      const node = this.createNode(
        `d${index}`,
        'declaration',
        entry.symbol.name,
        `${entry.symbol.kindLabel} · ${entry.role === 'definition' ? '定义' : '声明'}`,
        entry.symbol,
        entry.symbol.definition,
        parent,
        parent.depth + 1,
        state,
      );
      node.tags = [entry.role === 'definition' ? '定义' : '声明'];
      node.locationLabel = state.showLocations
        ? `${fileNameFromUri(entry.symbol.definition.uri)}:${entry.symbol.definition.startLine + 1}`
        : undefined;
      node.expandable = false;
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
      tags: symbol?.tags ? [...symbol.tags] : undefined,
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
    // A reference with no enclosing function/variable has no real Source
    // Insight relation owner. Do not invent a synthetic "global" node.
    if (!reference.caller) {
      continue;
    }
    // Do not merge same-named functions/variables from different files. Header
    // and source records for the same file still stay together.
    const key = [
      normalizeUriForComparison(reference.caller.definition.uri),
      reference.caller.isFunction ? 'function' : 'symbol',
      reference.caller.name,
    ].join('|');
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
    const nameA = a.caller?.name ?? '';
    const nameB = b.caller?.name ?? '';
    const byName = nameA.localeCompare(nameB);
    if (byName !== 0) {
      return byName;
    }
    return normalizeUriForComparison(a.caller?.definition.uri ?? '')
      .localeCompare(normalizeUriForComparison(b.caller?.definition.uri ?? ''));
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
  let instances = 0;
  let declarations = 0;
  const roots = [...left, ...right];
  for (const node of roots) {
    if (node.role === 'caller') {
      callers += 1;
    } else if (node.role === 'callee') {
      callees += 1;
    } else if (node.role === 'member') {
      members += 1;
    } else if (node.role === 'instance') {
      instances += 1;
    } else if (node.role === 'declaration') {
      declarations += 1;
    } else if (node.role === 'reference' || node.role === 'global') {
      references += 1;
    }
  }
  return {
    callers,
    callees,
    references,
    members,
    instances,
    declarations,
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
  if (mode === 'instances' || mode === 'memberAccess' || mode === 'declarations') {
    return false;
  }
  if (mode === 'contains' || mode === 'type' || mode === 'derived') {
    return symbol.isContainer || symbol.isTypedef === true;
  }
  return symbol.isFunction || symbol.isLabel === true;
}
