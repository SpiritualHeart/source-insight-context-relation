import * as vscode from 'vscode';
import {
  chooseBestDefinition,
  classifyReference,
  computeContextRange,
  dedupeLocations,
  isHeaderFile,
  locationKey,
  locationsEqual,
  makeLineExcerpt,
  type DefinitionCandidate,
  type ReferenceClassification,
} from './core';
import type {
  ContextLine,
  ContextMatchView,
  ContextViewKind,
  SourceLocation,
  TrackingMode,
} from './protocol';
import type {
  HostContext,
  HostReference,
  HostSymbol,
  WorkspaceAnalyzerConfig,
} from './internal';

const PROVIDER_DEFINITION = 'vscode.executeDefinitionProvider';
const PROVIDER_DECLARATION = 'vscode.executeDeclarationProvider';
const PROVIDER_REFERENCES = 'vscode.executeReferenceProvider';
const PROVIDER_TYPE_DEFINITION = 'vscode.executeTypeDefinitionProvider';
const PROVIDER_IMPLEMENTATION = 'vscode.executeImplementationProvider';
const PROVIDER_DOCUMENT_SYMBOLS = 'vscode.executeDocumentSymbolProvider';
const PROVIDER_WORKSPACE_SYMBOLS = 'vscode.executeWorkspaceSymbolProvider';

const SYMBOL_KIND = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

const FUNCTION_KINDS = new Set<number>([
  SYMBOL_KIND.Function,
  SYMBOL_KIND.Method,
  SYMBOL_KIND.Constructor,
  SYMBOL_KIND.Operator,
]);
const CONTAINER_KINDS = new Set<number>([
  SYMBOL_KIND.Namespace,
  SYMBOL_KIND.Package,
  SYMBOL_KIND.Module,
  SYMBOL_KIND.Class,
  SYMBOL_KIND.Interface,
  SYMBOL_KIND.Struct,
  SYMBOL_KIND.Enum,
  SYMBOL_KIND.Object,
]);
const VARIABLE_KINDS = new Set<number>([
  SYMBOL_KIND.Variable,
  SYMBOL_KIND.Field,
  SYMBOL_KIND.Property,
  SYMBOL_KIND.Constant,
  SYMBOL_KIND.EnumMember,
]);

const WORD_PATTERN = /[\p{L}_$][\p{L}\p{N}_$]*/u;
const COMMON_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'class', 'const', 'continue', 'default', 'delete', 'do',
  'double', 'else', 'enum', 'extern', 'false', 'final', 'float', 'for', 'from', 'function',
  'goto', 'if', 'import', 'inline', 'int', 'interface', 'long', 'namespace', 'new', 'nullptr',
  'override', 'private', 'protected', 'public', 'register', 'return', 'short', 'signed',
  'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try',
  'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while',
  'constexpr', 'consteval', 'constinit', 'co_await', 'co_return', 'co_yield', 'operator',
]);

export class NoSymbolError extends Error {
  constructor(message = '当前光标未位于函数名或变量名上。') {
    super(message);
    this.name = 'NoSymbolError';
  }
}

export class NoDefinitionError extends Error {
  constructor(public readonly word: string) {
    super(`未找到 “${word}” 的定义。`);
    this.name = 'NoDefinitionError';
  }
}

export class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis cancelled');
    this.name = 'AnalysisCancelledError';
  }
}

export interface SymbolRecord {
  name: string;
  qualifiedName: string;
  kind: number;
  detail: string;
  range: vscode.Range;
  selectionRange: vscode.Range;
  parent?: SymbolRecord;
  children: SymbolRecord[];
}

interface WordAtCursor {
  word: string;
  range: vscode.Range;
}

export interface RootResolution {
  symbol: HostSymbol;
  matches: ContextMatchView[];
  matchSymbols: HostSymbol[];
  word: string;
  unresolved: boolean;
}

export interface ContextSymbolState {
  symbol: HostSymbol;
  matches: ContextMatchView[];
  matchSymbols: HostSymbol[];
  view: ContextViewKind;
}

export class SymbolService {
  private readonly documentCache = new Map<string, Promise<vscode.TextDocument>>();
  private readonly symbolCache = new Map<string, { version: number; symbols: SymbolRecord[] }>();
  private readonly referenceCache = new Map<string, HostReference[]>();
  private readonly calleeCache = new Map<string, { symbol: HostSymbol; count: number }[]>();
  private readonly typeCache = new Map<string, HostSymbol | undefined>();
  private readonly memberCache = new Map<string, HostSymbol[]>();
  private readonly derivedCache = new Map<string, HostSymbol[]>();
  private readonly declarationCache = new Map<string, SourceLocation | undefined>();

  constructor(
    private readonly log: (message: string) => void,
    private readonly getConfig: () => WorkspaceAnalyzerConfig,
  ) {}

  clearCaches(): void {
    this.referenceCache.clear();
    this.calleeCache.clear();
    this.typeCache.clear();
    this.memberCache.clear();
    this.derivedCache.clear();
    this.declarationCache.clear();
    this.symbolCache.clear();
  }

  async resolveEditorSymbol(
    editor: vscode.TextEditor,
    trackingMode: TrackingMode,
    allowFallback: boolean,
    isStale: () => boolean,
  ): Promise<RootResolution> {
    const document = editor.document;
    const cursor = this.wordAt(editor);
    if (!cursor) {
      throw new NoSymbolError();
    }
    if (COMMON_KEYWORDS.has(cursor.word)) {
      throw new NoSymbolError(`“${cursor.word}” 是语言关键字，不是函数或变量。`);
    }

    if (trackingMode === 'enclosing') {
      const records = await this.getDocumentSymbols(document, isStale);
      const enclosing = findEnclosingSymbol(
        records,
        new vscode.Position(
          editor.selection.active.line,
          editor.selection.active.character,
        ),
      );
      if (enclosing) {
        const symbol = this.symbolFromRecord(document, enclosing);
        await this.decorateDeclaration(symbol, isStale);
        return {
          symbol,
          matches: [this.matchView(symbol, 0)],
          matchSymbols: [symbol],
          word: symbol.name,
          unresolved: false,
        };
      }
    }

    const localDefinition = await this.localDefinitionAt(
      document,
      cursor.word,
      cursor.range.start,
      isStale,
    );
    if (localDefinition) {
      await this.decorateDeclaration(localDefinition, isStale);
      return {
        symbol: localDefinition,
        matches: [this.matchView(localDefinition, 0)],
        matchSymbols: [localDefinition],
        word: cursor.word,
        unresolved: false,
      };
    }

    assertActive(isStale);
    const candidates = await this.resolveDefinitionCandidates(
      document.uri,
      cursor.range.start,
      cursor.word,
      isStale,
    );
    assertActive(isStale);

    if (candidates.length === 0 && !allowFallback) {
      throw new NoDefinitionError(cursor.word);
    }

    const chosen = chooseBestDefinition(candidates, {
      languageId: document.languageId,
      currentUri: document.uri.toString(),
    });
    const matchSymbols: HostSymbol[] = [];
    for (const candidate of candidates.slice(0, 10)) {
      assertActive(isStale);
      try {
        const symbol = await this.symbolFromLocation(
          candidate.location,
          cursor.word,
          isStale,
        );
        if (symbol && !matchSymbols.some((entry) => entry.key === symbol.key)) {
          matchSymbols.push(symbol);
        }
      } catch (error) {
        if (error instanceof AnalysisCancelledError) {
          throw error;
        }
      }
    }

    let root: HostSymbol;
    if (chosen) {
      root = matchSymbols.find((entry) => locationsEqual(entry.definition, chosen.location))
        ?? (await this.symbolFromLocation(chosen.location, cursor.word, isStale));
    } else {
      root = await this.fallbackSymbol(document, cursor.range, cursor.word);
    }
    await this.decorateDeclaration(root, isStale);
    if (matchSymbols.length === 0) {
      matchSymbols.push(root);
    } else {
      const withoutRoot = matchSymbols.filter((entry) => entry.key !== root.key);
      matchSymbols.length = 0;
      matchSymbols.push(root, ...withoutRoot);
    }

    return {
      symbol: root,
      matches: matchSymbols.map((symbol, index) => this.matchView(symbol, index)),
      matchSymbols,
      word: cursor.word,
      unresolved: !chosen,
    };
  }

  private async localDefinitionAt(
    document: vscode.TextDocument,
    name: string,
    position: vscode.Position,
    isStale: () => boolean,
  ): Promise<HostSymbol | undefined> {
    // cpptools can transiently answer a Go To Definition on a function
    // definition with the matching header prototype. The file being edited is
    // the authoritative definition when the cursor is already on a function
    // body, a source-level variable definition, or a type definition.
    if (isHeaderFile(document.uri.toString())) {
      return undefined;
    }
    const records = await this.getDocumentSymbols(document, isStale);
    const record = findSymbolAt(records, position, name);
    if (
      !record ||
      !record.selectionRange.contains(position)
    ) {
      return undefined;
    }
    const lineText = safeLineText(document, position.line);
    if (FUNCTION_KINDS.has(record.kind)) {
      if (!isFunctionDefinitionRecord(document, record)) {
        return undefined;
      }
    } else if (VARIABLE_KINDS.has(record.kind)) {
      if (/\bextern\b/.test(lineText)) {
        return undefined;
      }
    } else if (!CONTAINER_KINDS.has(record.kind)) {
      return undefined;
    }
    return this.symbolFromRecord(document, record);
  }

  async symbolFromEditorSelection(
    editor: vscode.TextEditor,
    isStale: () => boolean,
  ): Promise<HostSymbol> {
    const resolution = await this.resolveEditorSymbol(editor, 'symbol', true, isStale);
    return resolution.symbol;
  }

  async symbolFromLocation(
    location: SourceLocation,
    expectedName: string | undefined,
    isStale: () => boolean,
  ): Promise<HostSymbol> {
    const uri = vscode.Uri.parse(location.uri);
    const document = await this.getDocument(uri, isStale);
    const word = expectedName || this.wordTextAt(document, location.startLine, location.startCharacter);
    const aligned = alignLocationToWord(document, location, word);
    const records = await this.getDocumentSymbols(document, isStale);
    const position = new vscode.Position(aligned.startLine, aligned.startCharacter);
    const record = findSymbolAt(records, position, word)
      ?? findContainerAt(records, position);
    if (record) {
      const symbol = this.symbolFromRecord(document, record);
      const recordName = symbol.name.trim();
      const resolvedName = !recordName || isAnonymousSymbolName(recordName)
        ? word.trim() || recordName
        : recordName;
      if (resolvedName) {
        symbol.name = resolvedName;
        if (!symbol.detail || !symbol.detail.trim()) {
          symbol.detail = resolvedName;
        }
      }
      symbol.definition = {
        uri: document.uri.toString(),
        startLine: aligned.startLine,
        startCharacter: aligned.startCharacter,
        endLine: aligned.endLine,
        endCharacter: aligned.endCharacter,
      };
      symbol.key = makeSymbolKey(symbol.name, symbol.definition);
      return symbol;
    }
    return this.syntheticSymbol(document, aligned, word);
  }

  async decorateDeclaration(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<void> {
    if (this.declarationCache.has(symbol.key)) {
      symbol.declaration = this.declarationCache.get(symbol.key);
      return;
    }
    const result = await this.executeProvider<unknown>(
      PROVIDER_DECLARATION,
      [vscode.Uri.parse(symbol.definition.uri), new vscode.Position(
        symbol.definition.startLine,
        symbol.definition.startCharacter,
      )],
      isStale,
    );
    const candidates = normalizeProviderLocations(result, 'declaration')
      .map((candidate) => candidate.location)
      .filter((location) => !locationsEqual(location, symbol.definition));
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const header = Number(isHeaderFile(b.uri)) - Number(isHeaderFile(a.uri));
        return header !== 0 ? header : locationKey(a).localeCompare(locationKey(b));
      });
      symbol.declaration = candidates[0];
    } else {
      symbol.declaration = undefined;
    }
    this.declarationCache.set(symbol.key, symbol.declaration);
  }

  async findDeclarationFromReferences(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<SourceLocation | undefined> {
    if (symbol.declaration) {
      return symbol.declaration;
    }
    const refs = await this.getReferences(symbol, isStale);
    const declaration = refs.find((reference) => reference.role === 'declaration');
    if (declaration) {
      symbol.declaration = declaration.location;
      return declaration.location;
    }
    return undefined;
  }

  async getReferences(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<HostReference[]> {
    const cached = this.referenceCache.get(symbol.key);
    if (cached) {
      return cached;
    }
    const results = await this.executeProvider<unknown>(
      PROVIDER_REFERENCES,
      [
        vscode.Uri.parse(symbol.definition.uri),
        new vscode.Position(symbol.definition.startLine, symbol.definition.startCharacter),
      ],
      isStale,
    );
    const locations: SourceLocation[] = [];
    if (Array.isArray(results)) {
      for (const item of results) {
        const location = item as vscode.Location;
        if (!location?.uri || !location.range) {
          continue;
        }
        locations.push(toSourceLocation(location.uri, location.range));
      }
    }
    const unique = dedupeLocations(locations.map((location) => ({ location })))
      .map(({ location }) => location)
      .filter((location) => !locationsEqual(location, symbol.definition))
      .filter((location) => !symbol.declaration || !locationsEqual(location, symbol.declaration))
      .slice(0, this.getConfig().maxReferences);

    const enriched = await mapWithConcurrency(
      unique,
      5,
      async (location): Promise<HostReference | undefined> => {
        assertActive(isStale);
        try {
          const document = await this.getDocument(vscode.Uri.parse(location.uri), isStale);
          const lineText = safeLineText(document, location.startLine);
          let role: ReferenceClassification;
          if (!symbol.isFunction && isHeaderFile(location.uri) && /\bextern\b/.test(lineText)) {
            role = 'declaration';
          } else {
            role = classifyReference({
              name: symbol.name,
              lineText,
              isHeader: isHeaderFile(location.uri),
              isFunction: symbol.isFunction,
            });
          }
          const records = await this.getDocumentSymbols(document, isStale);
          const callerRecord = findEnclosingFunction(
            records,
            new vscode.Position(location.startLine, location.startCharacter),
          );
          const caller = callerRecord
            ? this.symbolFromRecord(document, callerRecord)
            : undefined;
          return {
            location,
            role: role as HostReference['role'],
            lineText,
            caller,
            callerName: caller?.name ?? '全局',
          };
        } catch (error) {
          if (error instanceof AnalysisCancelledError) {
            throw error;
          }
          this.log(`Reference inspection failed: ${String(error)}`);
          return undefined;
        }
      },
    );

    const result = enriched.filter((item): item is HostReference => item !== undefined);
    this.referenceCache.set(symbol.key, result);
    return result;
  }

  async getCallees(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<{ symbol: HostSymbol; count: number }[]> {
    const cached = this.calleeCache.get(symbol.key);
    if (cached) {
      return cached;
    }
    if (!symbol.isFunction || !symbol.fullRange) {
      return [];
    }
    const document = await this.getDocument(vscode.Uri.parse(symbol.definition.uri), isStale);
    const bodyLines: string[] = [];
    for (let line = symbol.fullRange.startLine; line <= symbol.fullRange.endLine; line += 1) {
      bodyLines.push(safeLineText(document, line));
    }
    const body = maskCommentsAndStrings(bodyLines.join('\n'));
    const openBrace = body.indexOf('{');
    const callPattern = /\b([A-Za-z_]\w*)\s*\(/g;
    const occurrences = new Map<string, { line: number; character: number; count: number }>();
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(body)) !== null) {
      const name = match[1];
      if (COMMON_KEYWORDS.has(name)) {
        continue;
      }
      if (name === symbol.name && (openBrace < 0 || match.index < openBrace)) {
        // Skip the function's own signature; keep real recursive calls in the body.
        continue;
      }
      const position = offsetToPosition(body, match.index);
      const absoluteLine = symbol.fullRange.startLine + position.line;
      const existing = occurrences.get(name);
      if (existing) {
        existing.count += 1;
      } else {
        occurrences.set(name, {
          line: absoluteLine,
          character: position.character,
          count: 1,
        });
      }
    }

    const entries = [...occurrences.entries()].slice(0, 120);
    const enriched = await mapWithConcurrency(entries, 4, async ([name, position]) => {
      assertActive(isStale);
      if (this.getConfig().excludedSymbols.includes(name)) {
        return undefined;
      }
      try {
        const candidates = await this.resolveDefinitionCandidates(
          document.uri,
          new vscode.Position(position.line, position.character),
          name,
          isStale,
        );
        const chosen = chooseBestDefinition(candidates, {
          languageId: document.languageId,
          currentUri: document.uri.toString(),
        });
        if (!chosen) {
          return undefined;
        }
        const target = await this.symbolFromLocation(chosen.location, name, isStale);
        if (!target.isFunction && !target.isMacro) {
          return undefined;
        }
        if (target.isMacro && this.getConfig().excludeMacros) {
          return undefined;
        }
        if (locationsEqual(target.definition, symbol.definition)) {
          return { symbol: target, count: position.count };
        }
        return { symbol: target, count: position.count };
      } catch (error) {
        if (error instanceof AnalysisCancelledError) {
          throw error;
        }
        return undefined;
      }
    });

    const grouped = new Map<string, { symbol: HostSymbol; count: number }>();
    for (const entry of enriched) {
      if (!entry) {
        continue;
      }
      const current = grouped.get(entry.symbol.key);
      if (current) {
        current.count += entry.count;
      } else {
        grouped.set(entry.symbol.key, entry);
      }
    }
    const result = [...grouped.values()].sort((a, b) => a.symbol.name.localeCompare(b.symbol.name));
    this.calleeCache.set(symbol.key, result);
    return result;
  }

  async getType(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<HostSymbol | undefined> {
    if (this.typeCache.has(symbol.key)) {
      return this.typeCache.get(symbol.key);
    }
    let typeSymbol: HostSymbol | undefined;
    const result = await this.executeProvider<unknown>(
      PROVIDER_TYPE_DEFINITION,
      [
        vscode.Uri.parse(symbol.definition.uri),
        new vscode.Position(symbol.definition.startLine, symbol.definition.startCharacter),
      ],
      isStale,
    );
    const candidates = normalizeProviderLocations(result, 'definition');
    const chosen = candidates[0];
    if (chosen) {
      try {
        typeSymbol = await this.symbolFromLocation(chosen.location, undefined, isStale);
      } catch {
        typeSymbol = undefined;
      }
    }

    if (
      !typeSymbol ||
      !typeSymbol.name.trim() ||
      isAnonymousSymbolName(typeSymbol.name)
    ) {
      const parsed = await this.parseTypeFromDeclaration(symbol, isStale);
      if (parsed) {
        typeSymbol = parsed;
      }
    }
    if (typeSymbol && isAnonymousSymbolName(typeSymbol.name)) {
      const inferred = await this.inferTypeNameFromDeclaration(symbol, isStale);
      if (inferred) {
        typeSymbol.name = inferred;
        if (!(typeSymbol.detail ?? '').trim()) {
          typeSymbol.detail = inferred;
        }
        typeSymbol.key = makeSymbolKey(inferred, typeSymbol.definition);
      }
    }
    this.typeCache.set(symbol.key, typeSymbol);
    return typeSymbol;
  }

  async getMembers(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<HostSymbol[]> {
    const cached = this.memberCache.get(symbol.key);
    if (cached) {
      return cached;
    }
    const document = await this.getDocument(
      vscode.Uri.parse(symbol.definition.uri),
      isStale,
    );
    const records = await this.getDocumentSymbols(document, isStale);
    const position = new vscode.Position(
      symbol.definition.startLine,
      symbol.definition.startCharacter,
    );
    let record = findSymbolAt(records, position, symbol.name)
      ?? findContainerAt(records, position);
    if (!record || record.children.length === 0) {
      record = findContainerWithChildrenAt(records, position)
        ?? findNearbyContainerWithChildren(records, position)
        ?? record;
    }
    const members: HostSymbol[] = [];
    if (record) {
      for (const child of record.children) {
        members.push(this.symbolFromRecord(document, child));
      }
    }
    this.memberCache.set(symbol.key, members);
    return members;
  }

  async getDerived(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<HostSymbol[]> {
    const cached = this.derivedCache.get(symbol.key);
    if (cached) {
      return cached;
    }
    const result = await this.executeProvider<unknown>(
      PROVIDER_IMPLEMENTATION,
      [
        vscode.Uri.parse(symbol.definition.uri),
        new vscode.Position(symbol.definition.startLine, symbol.definition.startCharacter),
      ],
      isStale,
    );
    const locations = normalizeProviderLocations(result, 'definition')
      .map((candidate) => candidate.location)
      .filter((location) => !locationsEqual(location, symbol.definition));
    const derived: HostSymbol[] = [];
    for (const location of locations.slice(0, 50)) {
      try {
        derived.push(await this.symbolFromLocation(location, undefined, isStale));
      } catch {
        // Ignore symbols that cannot be inspected.
      }
    }
    this.derivedCache.set(symbol.key, derived);
    return derived;
  }

  async getContext(
    symbol: HostSymbol,
    view: ContextViewKind,
    matchSymbols: HostSymbol[],
    matches: ContextMatchView[],
    activeMatch: number,
    isStale: () => boolean,
  ): Promise<HostContext> {
    const typeSymbol = symbol.isVariable ? await this.getType(symbol, isStale) : undefined;
    let displaySymbol = symbol;
    let location = symbol.definition;
    if (view === 'declaration' && symbol.declaration) {
      location = symbol.declaration;
    } else if (view === 'type' && typeSymbol) {
      displaySymbol = typeSymbol;
      location = typeSymbol.definition;
    }

    const document = await this.getDocument(vscode.Uri.parse(location.uri), isStale);
    const aligned = alignLocationToWord(document, location, displaySymbol.name);
    const records = await this.getDocumentSymbols(document, isStale);
    const position = new vscode.Position(aligned.startLine, aligned.startCharacter);
    const record = findSymbolAt(records, position, displaySymbol.name)
      ?? findContainerAt(records, position);
    const config = this.getConfig();
    const range = computeContextRange({
      totalLines: document.lineCount,
      targetStartLine: aligned.startLine,
      targetEndLine: aligned.endLine,
      symbolStartLine:
        (displaySymbol.isFunction || displaySymbol.isContainer) && record
          ? record.range.start.line
          : undefined,
      symbolEndLine:
        (displaySymbol.isFunction || displaySymbol.isContainer) && record
          ? record.range.end.line
          : undefined,
      contextLines: config.contextLines,
      maxLines: config.maxContextLines,
    });

    const lines: ContextLine[] = [];
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      const text = safeLineText(document, line);
      lines.push({
        line,
        text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
      });
    }

    const availableViews: ContextViewKind[] = ['definition'];
    if (symbol.declaration) {
      availableViews.push('declaration');
    }
    if (typeSymbol) {
      availableViews.push('type');
    }

    return {
      symbol,
      targetName: displaySymbol.name,
      matches,
      activeMatch,
      activeView: availableViews.includes(view) ? view : 'definition',
      availableViews,
      lines,
      startLine: range.startLine,
      endLine: range.endLine,
      targetStartLine: aligned.startLine,
      targetEndLine: aligned.endLine,
      targetStartCharacter: aligned.startCharacter,
      targetEndCharacter: aligned.endCharacter,
      truncatedTop: range.truncatedTop,
      truncatedBottom: range.truncatedBottom,
      totalLines: document.lineCount,
      languageId: document.languageId,
      typeSymbol,
    };
  }

  async getSymbolAtLocationForPreview(
    location: SourceLocation,
    name: string,
    isStale: () => boolean,
  ): Promise<HostSymbol> {
    return this.symbolFromLocation(location, name, isStale);
  }

  async getDocumentSymbols(
    document: vscode.TextDocument,
    isStale: () => boolean,
  ): Promise<SymbolRecord[]> {
    const key = document.uri.toString();
    const cached = this.symbolCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.symbols;
    }
    const results = await this.executeProvider<unknown>(
      PROVIDER_DOCUMENT_SYMBOLS,
      [document.uri],
      isStale,
    );
    const symbols = convertSymbols(results);
    this.symbolCache.set(key, { version: document.version, symbols });
    if (this.symbolCache.size > 300) {
      const first = this.symbolCache.keys().next();
      if (!first.done) {
        this.symbolCache.delete(first.value);
      }
    }
    return symbols;
  }

  async getDocument(
    uri: vscode.Uri,
    isStale: () => boolean,
  ): Promise<vscode.TextDocument> {
    const key = uri.toString();
    let promise = this.documentCache.get(key);
    if (!promise) {
      promise = Promise.resolve(vscode.workspace.openTextDocument(uri));
      this.documentCache.set(key, promise);
      promise.catch(() => this.documentCache.delete(key));
    }
    const document = await promise;
    assertActive(isStale);
    return document;
  }

  async executeProvider<T>(
    command: string,
    args: unknown[],
    isStale: () => boolean,
  ): Promise<T | undefined> {
    assertActive(isStale);
    const timeoutMs = Math.max(1000, this.getConfig().providerTimeoutMs);
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve(vscode.commands.executeCommand<T>(command, ...args)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${command} exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      assertActive(isStale);
      return value;
    } catch (error) {
      if (error instanceof AnalysisCancelledError) {
        throw error;
      }
      if (error instanceof Error && /exceeded \d+ms/.test(error.message)) {
        this.log(error.message);
      }
      return undefined;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async findEnclosingSymbolForPosition(
    uri: vscode.Uri,
    position: vscode.Position,
    isStale: () => boolean,
  ): Promise<HostSymbol | undefined> {
    const document = await this.getDocument(uri, isStale);
    const records = await this.getDocumentSymbols(document, isStale);
    const record = findEnclosingSymbol(records, position);
    return record ? this.symbolFromRecord(document, record) : undefined;
  }

  private async resolveDefinitionCandidates(
    uri: vscode.Uri,
    position: vscode.Position,
    word: string,
    isStale: () => boolean,
  ): Promise<DefinitionCandidate[]> {
    const candidates: DefinitionCandidate[] = [];
    const definitionResults = await this.executeProvider<unknown>(
      PROVIDER_DEFINITION,
      [uri, position],
      isStale,
    );
    candidates.push(...normalizeProviderLocations(definitionResults, 'definition'));
    assertActive(isStale);
    if (candidates.length === 0) {
      const declarationResults = await this.executeProvider<unknown>(
        PROVIDER_DECLARATION,
        [uri, position],
        isStale,
      );
      candidates.push(...normalizeProviderLocations(declarationResults, 'declaration'));
    }
    assertActive(isStale);
    if (candidates.length === 0) {
      const workspaceResults = await this.executeProvider<unknown>(
        PROVIDER_WORKSPACE_SYMBOLS,
        [word],
        isStale,
      );
      if (Array.isArray(workspaceResults)) {
        for (const item of workspaceResults) {
          const entry = item as { name?: string; location?: vscode.Location };
          if (entry?.name !== word || !entry.location) {
            continue;
          }
          candidates.push({
            location: toSourceLocation(entry.location.uri, entry.location.range),
            origin: 'workspace',
          });
        }
      }
    }
    return dedupeLocations(candidates);
  }

  private async inferTypeNameFromDeclaration(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<string | undefined> {
    const document = await this.getDocument(
      vscode.Uri.parse(symbol.definition.uri),
      isStale,
    );
    const text = safeLineText(document, symbol.definition.startLine);
    const beforeName = text.slice(0, Math.max(0, symbol.definition.startCharacter));
    const structMatch = /\b(?:struct|class|union|enum)\s+([A-Za-z_]\w*)\s*[*&\s]*$/.exec(
      beforeName,
    );
    let typeName = structMatch?.[1];
    if (!typeName) {
      const identifiers = [...beforeName.matchAll(/\b([A-Za-z_]\w*)\b/g)];
      const last = identifiers[identifiers.length - 1];
      if (last) {
        typeName = last[1];
      }
    }
    if (!typeName || COMMON_KEYWORDS.has(typeName)) {
      return undefined;
    }
    return typeName;
  }

  private async parseTypeFromDeclaration(
    symbol: HostSymbol,
    isStale: () => boolean,
  ): Promise<HostSymbol | undefined> {
    const typeName = await this.inferTypeNameFromDeclaration(symbol, isStale);
    if (!typeName) {
      return undefined;
    }
    const workspaceResults = await this.executeProvider<unknown>(
      PROVIDER_WORKSPACE_SYMBOLS,
      [typeName],
      isStale,
    );
    if (Array.isArray(workspaceResults)) {
      for (const item of workspaceResults) {
        const entry = item as { name?: string; kind?: number; location?: vscode.Location };
        if (entry?.name !== typeName || !entry.location) {
          continue;
        }
        if (typeof entry.kind === 'number' && !CONTAINER_KINDS.has(entry.kind)) {
          continue;
        }
        try {
          return await this.symbolFromLocation(
            toSourceLocation(entry.location.uri, entry.location.range),
            typeName,
            isStale,
          );
        } catch {
          // Continue trying the next workspace symbol.
        }
      }
    }
    return undefined;
  }

  private wordAt(editor: vscode.TextEditor): WordAtCursor | undefined {
    const selection = editor.selection;
    if (!selection.isEmpty) {
      const selectedText = editor.document.getText(selection).trim();
      if (/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(selectedText)) {
        const offset = editor.document.getText(selection).indexOf(selectedText);
        const start = selection.start.translate(0, Math.max(0, offset));
        return {
          word: selectedText,
          range: new vscode.Range(start, start.translate(0, selectedText.length)),
        };
      }
    }
    const range = editor.document.getWordRangeAtPosition(selection.active, WORD_PATTERN);
    if (!range) {
      return undefined;
    }
    return {
      word: editor.document.getText(range),
      range,
    };
  }

  private wordTextAt(
    document: vscode.TextDocument,
    line: number,
    character: number,
  ): string {
    const text = safeLineText(document, line);
    const index = Math.max(0, Math.min(character, text.length));
    const range = document.getWordRangeAtPosition(
      new vscode.Position(line, index),
      WORD_PATTERN,
    );
    return range ? document.getText(range) : '';
  }

  private matchView(symbol: HostSymbol, index: number): ContextMatchView {
    return {
      index,
      label: symbol.name,
      kindLabel: symbol.kindLabel,
      detail: symbol.detail,
    };
  }

  private symbolFromRecord(
    document: vscode.TextDocument,
    record: SymbolRecord,
  ): HostSymbol {
    const selection = alignRangeToWord(
      document,
      record.selectionRange,
      record.name,
    );
    const descriptor = describeKind(record.kind, record.name, document.languageId);
    const definition = toSourceLocation(document.uri, selection);
    return {
      key: makeSymbolKey(record.name, definition),
      name: cleanSymbolName(record.name) || record.name,
      kindId: descriptor.id,
      kindLabel: descriptor.label,
      isFunction: FUNCTION_KINDS.has(record.kind),
      isVariable: VARIABLE_KINDS.has(record.kind),
      isContainer: CONTAINER_KINDS.has(record.kind),
      isMacro: isMacroLine(document, selection.start.line),
      languageId: document.languageId,
      definition,
      fullRange: {
        startLine: record.range.start.line,
        endLine: record.range.end.line,
      },
      detail: record.detail || record.name,
    };
  }

  private syntheticSymbol(
    document: vscode.TextDocument,
    location: SourceLocation,
    name: string,
  ): HostSymbol {
    const lineText = safeLineText(document, location.startLine);
    const isMacro = /^\s*#\s*define\b/.test(lineText);
    const isFunction = !isMacro && likelyFunctionLine(lineText, name);
    const descriptor = isMacro
      ? { id: 'macro', label: '宏' }
      : isFunction
        ? { id: 'function', label: '函数' }
        : { id: 'symbol', label: '符号' };
    return {
      key: makeSymbolKey(name, location),
      name,
      kindId: descriptor.id,
      kindLabel: descriptor.label,
      isFunction,
      isVariable: !isFunction && !isMacro,
      isContainer: false,
      isMacro,
      languageId: document.languageId,
      definition: location,
      detail: makeLineExcerpt(lineText, 180),
    };
  }

  private async fallbackSymbol(
    document: vscode.TextDocument,
    range: vscode.Range,
    word: string,
  ): Promise<HostSymbol> {
    const location = toSourceLocation(document.uri, range);
    return this.syntheticSymbol(document, location, word);
  }
}

function describeKind(kind: number, name: string, languageId: string): { id: string; label: string } {
  if (isMacroName(name, languageId)) {
    return { id: 'macro', label: '宏' };
  }
  switch (kind) {
    case SYMBOL_KIND.Method:
      return { id: 'method', label: '方法' };
    case SYMBOL_KIND.Constructor:
      return { id: 'constructor', label: '构造函数' };
    case SYMBOL_KIND.Operator:
      return { id: 'function', label: '运算符' };
    case SYMBOL_KIND.Function:
      return { id: 'function', label: '函数' };
    case SYMBOL_KIND.Variable:
      return { id: 'variable', label: '变量' };
    case SYMBOL_KIND.Constant:
      return { id: 'constant', label: '常量' };
    case SYMBOL_KIND.Field:
      return { id: 'field', label: '字段' };
    case SYMBOL_KIND.Property:
      return { id: 'property', label: '属性' };
    case SYMBOL_KIND.Class:
      return { id: 'class', label: '类' };
    case SYMBOL_KIND.Struct:
      return { id: 'struct', label: '结构体' };
    case SYMBOL_KIND.Enum:
      return { id: 'enum', label: '枚举' };
    case SYMBOL_KIND.EnumMember:
      return { id: 'constant', label: '枚举成员' };
    case SYMBOL_KIND.Interface:
      return { id: 'class', label: '接口' };
    case SYMBOL_KIND.Namespace:
      return { id: 'namespace', label: '命名空间' };
    case SYMBOL_KIND.Module:
      return { id: 'module', label: '模块' };
    default:
      return { id: 'symbol', label: '符号' };
  }
}

function isMacroName(name: string, languageId: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(name) && /^(c|cpp|cuda-cpp|objective-c|objective-cpp)$/.test(languageId);
}

function isMacroLine(document: vscode.TextDocument, line: number): boolean {
  return /^\s*#\s*define\b/.test(safeLineText(document, line));
}

function makeSymbolKey(name: string, location: SourceLocation): string {
  return `${normalizeSymbolName(name)}:${locationKey(location)}`;
}

function normalizeSymbolName(name: string): string {
  return cleanSymbolName(name).trim();
}

export function cleanSymbolName(rawName: string): string {
  const name = rawName.trim();
  if (!name || name.startsWith('operator')) {
    return name;
  }
  const paren = name.indexOf('(');
  return paren > 0 ? name.slice(0, paren).trim() : name;
}

function isFunctionDefinitionRecord(
  document: vscode.TextDocument,
  record: SymbolRecord,
): boolean {
  const start = record.selectionRange.end;
  const startOffset = document.offsetAt(start);
  const endOffset = Math.min(document.getText().length, startOffset + 500);
  const tail = document.getText(
    new vscode.Range(start, document.positionAt(endOffset)),
  );
  const brace = tail.indexOf('{');
  const semicolon = tail.indexOf(';');
  return brace >= 0 && (semicolon < 0 || brace < semicolon);
}

function isAnonymousSymbolName(name: string): boolean {
  const trimmed = name.trim();
  return /^__unnamed_/i.test(trimmed)
    || /^anonymous$/i.test(trimmed)
    || /^<anonymous/i.test(trimmed);
}

function findContainerAt(
  symbols: SymbolRecord[],
  position: vscode.Position,
): SymbolRecord | undefined {
  const matches: SymbolRecord[] = [];
  const visit = (records: SymbolRecord[]): void => {
    for (const record of records) {
      if (CONTAINER_KINDS.has(record.kind) && record.range.contains(position)) {
        matches.push(record);
      }
      visit(record.children);
    }
  };
  visit(symbols);
  matches.sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
  return matches[0];
}

function findNearbyContainerWithChildren(
  symbols: SymbolRecord[],
  position: vscode.Position,
): SymbolRecord | undefined {
  const matches: Array<{ record: SymbolRecord; distance: number }> = [];
  const visit = (records: SymbolRecord[]): void => {
    for (const record of records) {
      if (CONTAINER_KINDS.has(record.kind) && record.children.length > 0) {
        const distance = record.range.contains(position)
          ? 0
          : position.line < record.range.start.line
            ? record.range.start.line - position.line
            : position.line - record.range.end.line;
        if (distance <= 2) {
          matches.push({ record, distance });
        }
      }
      visit(record.children);
    }
  };
  visit(symbols);
  matches.sort((a, b) => {
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    return rangeSize(a.record.range) - rangeSize(b.record.range);
  });
  return matches[0]?.record;
}

function findContainerWithChildrenAt(
  symbols: SymbolRecord[],
  position: vscode.Position,
): SymbolRecord | undefined {
  const matches: SymbolRecord[] = [];
  const visit = (records: SymbolRecord[]): void => {
    for (const record of records) {
      if (
        CONTAINER_KINDS.has(record.kind) &&
        record.children.length > 0 &&
        record.range.contains(position)
      ) {
        matches.push(record);
      }
      visit(record.children);
    }
  };
  visit(symbols);
  matches.sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
  return matches[0];
}

function findSymbolAt(
  symbols: SymbolRecord[],
  position: vscode.Position,
  name: string,
): SymbolRecord | undefined {
  const matches: SymbolRecord[] = [];
  const visit = (records: SymbolRecord[]): void => {
    for (const record of records) {
      if (
        record.name === name &&
        (record.selectionRange.contains(position) || record.range.contains(position))
      ) {
        matches.push(record);
      }
      visit(record.children);
    }
  };
  visit(symbols);
  if (matches.length === 0) {
    const byName = (records: SymbolRecord[]): void => {
      for (const record of records) {
        if (record.name === name) {
          matches.push(record);
        }
        byName(record.children);
      }
    };
    byName(symbols);
  }
  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
  return matches[0];
}

function findEnclosingSymbol(
  symbols: SymbolRecord[],
  position: vscode.Position,
): SymbolRecord | undefined {
  const matches: SymbolRecord[] = [];
  const visit = (records: SymbolRecord[]): void => {
    for (const record of records) {
      if (
        (FUNCTION_KINDS.has(record.kind) || CONTAINER_KINDS.has(record.kind)) &&
        record.range.contains(position)
      ) {
        matches.push(record);
      }
      visit(record.children);
    }
  };
  visit(symbols);
  matches.sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
  return matches[0];
}

function findEnclosingFunction(
  symbols: SymbolRecord[],
  position: vscode.Position,
): SymbolRecord | undefined {
  const matches: SymbolRecord[] = [];
  const visit = (records: SymbolRecord[]): void => {
    for (const record of records) {
      if (FUNCTION_KINDS.has(record.kind) && record.range.contains(position)) {
        matches.push(record);
      }
      visit(record.children);
    }
  };
  visit(symbols);
  matches.sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
  return matches[0];
}

function rangeSize(range: vscode.Range): number {
  if (range.start.line !== range.end.line) {
    return (range.end.line - range.start.line) * 100000 +
      (range.end.character - range.start.character);
  }
  return range.end.character - range.start.character;
}

function alignRangeToWord(
  document: vscode.TextDocument,
  range: vscode.Range,
  word: string,
): vscode.Range {
  const name = cleanSymbolName(word);
  if (!name) {
    return range;
  }
  if (range.start.line === range.end.line && document.getText(range) === name) {
    return range;
  }
  const line = Math.max(0, Math.min(range.start.line, document.lineCount - 1));
  const text = safeLineText(document, line);
  let best = -1;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(name, from);
    if (index < 0) {
      break;
    }
    if (best < 0 || Math.abs(index - range.start.character) < Math.abs(best - range.start.character)) {
      best = index;
    }
    from = index + Math.max(1, name.length);
  }
  if (best >= 0) {
    return new vscode.Range(line, best, line, best + name.length);
  }
  return range;
}

function alignLocationToWord(
  document: vscode.TextDocument,
  location: SourceLocation,
  word: string,
): SourceLocation {
  const range = alignRangeToWord(
    document,
    new vscode.Range(
      location.startLine,
      location.startCharacter,
      location.endLine,
      location.endCharacter,
    ),
    word,
  );
  return toSourceLocation(document.uri, range);
}

function likelyFunctionLine(lineText: string, name: string): boolean {
  if (/^\s*#\s*define\b/.test(lineText)) {
    return false;
  }
  if (!new RegExp(`\\b${escapeRegExp(name)}\\b\\s*\\(`).test(lineText)) {
    return false;
  }
  const index = lineText.search(new RegExp(`\\b${escapeRegExp(name)}\\b`));
  const before = index > 0 ? lineText.slice(0, index).trim() : '';
  if (!before) {
    return false;
  }
  if (/(?:return|if|while|for|switch|case|new|delete|throw|sizeof|co_return)\s*$/.test(before)) {
    return false;
  }
  if (/[=,?.(:[&|+\-*/%<>!]\s*$/.test(before)) {
    return false;
  }
  return true;
}

function convertSymbols(value: unknown): SymbolRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return convertSymbolList(value, undefined);
}

function convertSymbolList(value: unknown[], parent: SymbolRecord | undefined): SymbolRecord[] {
  const records: SymbolRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as {
      name?: string;
      kind?: number;
      detail?: string;
      range?: vscode.Range;
      selectionRange?: vscode.Range;
      location?: vscode.Location;
      children?: unknown[];
    };
    const rawName = typeof entry.name === 'string' ? entry.name : '';
    if (!rawName) {
      continue;
    }
    const name = cleanSymbolName(rawName);
    const range = entry.range ?? entry.location?.range;
    if (!range) {
      continue;
    }
    const selectionRange = entry.selectionRange ?? range;
    const kind = typeof entry.kind === 'number' ? entry.kind : SYMBOL_KIND.Variable;
    const qualifiedName = makeQualifiedName(name, parent);
    const record: SymbolRecord = {
      name,
      qualifiedName,
      kind,
      detail: entry.detail || rawName,
      range,
      selectionRange,
      parent,
      children: [],
    };
    if (Array.isArray(entry.children)) {
      record.children = convertSymbolList(entry.children, record);
    }
    records.push(record);
  }
  return records;
}

function makeQualifiedName(name: string, parent: SymbolRecord | undefined): string {
  if (!parent) {
    return name;
  }
  if (CONTAINER_KINDS.has(parent.kind)) {
    return `${parent.qualifiedName}::${name}`;
  }
  return name;
}

function normalizeProviderLocations(
  value: unknown,
  origin: 'definition' | 'declaration',
): DefinitionCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates: DefinitionCandidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as {
      targetUri?: vscode.Uri;
      targetRange?: vscode.Range;
      targetSelectionRange?: vscode.Range;
      uri?: vscode.Uri;
      range?: vscode.Range;
    };
    const uri = entry.targetUri ?? entry.uri;
    const range = entry.targetSelectionRange ?? entry.targetRange ?? entry.range;
    if (!uri || !range) {
      continue;
    }
    candidates.push({
      location: toSourceLocation(uri, range),
      origin,
    });
  }
  return candidates;
}

function toSourceLocation(uri: vscode.Uri, range: vscode.Range): SourceLocation {
  return {
    uri: uri.toString(),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

function safeLineText(document: vscode.TextDocument, line: number): string {
  if (line < 0 || line >= document.lineCount) {
    return '';
  }
  return document.lineAt(line).text;
}

function assertActive(isStale: () => boolean): void {
  if (isStale()) {
    throw new AnalysisCancelledError();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskCommentsAndStrings(text: string): string {
  let result = '';
  let index = 0;
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' = 'code';
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment';
        result += '  ';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        result += '  ';
        index += 2;
        continue;
      }
      if (char === "'") {
        state = 'single';
        result += ' ';
        index += 1;
        continue;
      }
      if (char === '"') {
        state = 'double';
        result += ' ';
        index += 1;
        continue;
      }
      result += char;
      index += 1;
      continue;
    }
    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        result += '\n';
      } else {
        result += ' ';
      }
      index += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        result += '  ';
        index += 2;
        continue;
      }
      result += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (char === '\\') {
        result += '  ';
        index += 2;
        continue;
      }
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"')) {
        state = 'code';
        result += ' ';
        index += 1;
        continue;
      }
      result += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
  }
  return result;
}

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lastNewline = -1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      lastNewline = index;
    }
  }
  return { line, character: offset - lastNewline - 1 };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function readConfig(): WorkspaceAnalyzerConfig {
  const config = vscode.workspace.getConfiguration('sourceInsight');
  return {
    contextLines: clampNumber(config.get<number>('contextLines'), 12, 2, 200),
    maxContextLines: clampNumber(config.get<number>('maxContextLines'), 600, 40, 3000),
    maxReferences: clampNumber(config.get<number>('maxReferences'), 300, 20, 2000),
    maxRelationNodes: clampNumber(config.get<number>('maxRelationNodes'), 500, 50, 5000),
    providerTimeoutMs: clampNumber(config.get<number>('providerTimeoutMs'), 15000, 3000, 120000),
    sortReferencesByFile: config.get<boolean>('sortReferencesByFile') ?? true,
    excludeMacros: config.get<boolean>('excludeMacros') ?? false,
    excludedSymbols: config.get<string[]>('excludedSymbols') ?? [],
    showLocations: config.get<boolean>('showLocations') ?? false,
    expandDuplicateBranches: config.get<boolean>('expandDuplicateBranches') ?? false,
    contextLineNumbers: config.get<boolean>('contextLineNumbers') ?? true,
    relationLineStyle: readLineStyle(config.get<string>('relationLineStyle')),
    relationSpacing: clampNumber(config.get<number>('relationSpacing'), 40, 18, 120),
    relationArrows: config.get<boolean>('relationArrows') ?? true,
    relationNodeShadow: config.get<boolean>('relationNodeShadow') ?? true,
  };
}

function readLineStyle(value: unknown): 'elbow' | 'curve' | 'direct' {
  if (value === 'curve' || value === 'direct') {
    return value;
  }
  return 'elbow';
}

function clampNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
