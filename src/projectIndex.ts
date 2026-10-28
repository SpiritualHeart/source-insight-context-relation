import * as vscode from 'vscode';
import {
  buildSearchRegExp,
  classifyCUse,
  classifyVariableUse,
  findWordAtLine,
  isHeaderPath,
  isIndexablePath,
  parseSourceFile,
  type CDecl,
  type CFileModel,
  type CKind,
  type CUseRole,
  type CWord,
  type SearchOptions,
} from './cParser';
import type { SourceLocation } from './protocol';

export interface IndexedDecl {
  decl: CDecl;
  model: CFileModel;
}

export interface CResolution {
  decl: CDecl;
  model: CFileModel;
  alternatives: CDecl[];
  word: string;
  /** Set when the cursor is on `p->field` / `s.field`. */
  memberAccess?: {
    ownerName: string;
    member: string;
    operator: '.' | '->';
  };
}

export interface CTypeTarget {
  name: string;
  decl?: CDecl;
  model?: CFileModel;
  isPointer: boolean;
  /** Set for typedef aliases that add an extra pointer level. */
  aliasPointer: boolean;
}

export interface CInstanceEntry {
  decl: CDecl;
  model: CFileModel;
  isPointer: boolean;
  isField: boolean;
}

export interface CReferenceEntry {
  location: SourceLocation;
  role: CUseRole | 'declaration';
  lineText: string;
  owner?: CDecl;
  ownerModel?: CFileModel;
  ownerName: string;
}

export interface CDeclarationEntry {
  decl: CDecl;
  model: CFileModel;
  role: 'definition' | 'declaration';
}

export interface CMemberUseEntry {
  member: string;
  operator: '.' | '->';
  field?: CDecl;
  sites: Array<{ location: SourceLocation; role: 'read' | 'write' }>;
}

export interface CSearchMatch {
  uri: string;
  fileName: string;
  line: number;
  character: number;
  endCharacter: number;
  text: string;
}

export interface CSearchResult {
  pattern: string;
  matches: CSearchMatch[];
  total: number;
  truncated: boolean;
}

export interface CSearchGroup {
  uri: string;
  fileName: string;
  line: number;
  character: number;
  endCharacter: number;
  text: string;
}

const MAX_SEARCH_RESULTS = 2000;

export function declLocation(decl: CDecl): SourceLocation {
  return {
    uri: decl.fileUri,
    startLine: decl.line,
    startCharacter: decl.nameStart,
    endLine: decl.line,
    endCharacter: decl.nameEnd,
  };
}

export function declKey(decl: CDecl): string {
  return `${decl.fileUri}:${decl.line}:${decl.nameStart}:${decl.kind}:${decl.name}`;
}

function uriPath(uri: string): string {
  try {
    return vscode.Uri.parse(uri).fsPath;
  } catch {
    return uri;
  }
}

function folderOf(uri: string): string {
  const path = uriPath(uri).replace(/\\/g, '/');
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : path;
}

function isSameKindFamily(a: CKind, b: CKind): boolean {
  const functions: CKind[] = ['function', 'prototype'];
  const variables: CKind[] = ['variable', 'field'];
  const types: CKind[] = ['struct', 'union', 'enum', 'typedef'];
  return (functions.includes(a) && functions.includes(b))
    || (variables.includes(a) && variables.includes(b))
    || (types.includes(a) && types.includes(b))
    || a === b;
}

export class ProjectIndex implements vscode.Disposable {
  private readonly models = new Map<string, { model: CFileModel; version: number }>();
  private nameIndex = new Map<string, IndexedDecl[]>();
  /** name -> parallel [model, word-index] arrays built from indexed files. */
  private occurrenceIndex = new Map<string, { models: CFileModel[]; wordIndexes: number[] }>();
  private indexPromise: Promise<void> | undefined;
  private ready = false;
  private disposed = false;
  private readonly watchers: vscode.Disposable[] = [];

  constructor(private readonly log: (message: string) => void) {
    this.watchers.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!this.isSupportedDocument(document)) {
          return;
        }
        this.invalidate(document.uri, document.version);
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (!this.isSupportedDocument(document) || this.models.has(document.uri.toString())) {
          return;
        }
        if (this.ready) {
          this.loadDocument(document).catch(() => undefined);
        }
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        let changed = false;
        for (const uri of event.files) {
          if (this.models.delete(uri.toString())) {
            changed = true;
          }
        }
        if (changed) {
          this.rebuildIndexes();
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        let changed = false;
        for (const file of event.files) {
          if (this.models.delete(file.oldUri.toString())) {
            changed = true;
          }
        }
        if (changed) {
          this.rebuildIndexes();
        }
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers.length = 0;
    this.models.clear();
    this.nameIndex.clear();
    this.occurrenceIndex.clear();
  }

  isSupportedDocument(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file') {
      return false;
    }
    return isIndexablePath(document.uri.fsPath);
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Build the project symbol database. Safe to call repeatedly. */
  async ensureIndexed(): Promise<void> {
    if (this.ready || this.disposed) {
      return;
    }
    if (this.indexPromise) {
      return this.indexPromise;
    }
    this.indexPromise = this.buildIndex();
    try {
      await this.indexPromise;
    } finally {
      this.indexPromise = undefined;
    }
  }

  private async buildIndex(): Promise<void> {
    const config = vscode.workspace.getConfiguration('sourceInsight');
    if (config.get<boolean>('enableProjectIndex') === false) {
      this.ready = true;
      return;
    }
    const started = Date.now();
    const maxSize = Math.max(64 * 1024, config.get<number>('maxIndexFileSize') ?? 2 * 1024 * 1024);
    const files = await vscode.workspace.findFiles(
      '**/*.{c,h,s,S,asm,inc}',
      '{**/node_modules/**,**/build/**,**/out/**,**/dist/**,**/.git/**,**/Debug/**,**/Release/**}',
      40000,
    );
    const openDocuments = new Map<string, vscode.TextDocument>();
    for (const document of vscode.workspace.textDocuments) {
      openDocuments.set(document.uri.toString(), document);
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, Math.max(1, files.length)) }, async () => {
      while (!this.disposed) {
        const index = cursor;
        cursor += 1;
        if (index >= files.length) {
          return;
        }
        const uri = files[index];
        try {
          const open = openDocuments.get(uri.toString());
          let text: string;
          let version: number;
          if (open) {
            text = open.getText();
            version = open.version;
          } else {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > maxSize) {
              continue;
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            text = new TextDecoder('utf-8').decode(bytes);
            version = -1;
          }
          if (!text.trim()) {
            continue;
          }
          const model = parseSourceFile(uri.toString(), uri.fsPath, text);
          this.models.set(uri.toString(), { model, version });
        } catch (error) {
          this.log(`Index file failed: ${uri.fsPath}: ${String(error)}`);
        }
      }
    });
    await Promise.all(workers);
    this.rebuildIndexes();
    this.ready = true;
    this.log(`Indexed ${this.models.size} files in ${Date.now() - started}ms.`);
  }

  async rebuild(): Promise<void> {
    this.models.clear();
    this.nameIndex.clear();
    this.occurrenceIndex.clear();
    this.ready = false;
    await this.ensureIndexed();
  }

  invalidate(uri: vscode.Uri, version?: number): void {
    const key = uri.toString();
    const existing = this.models.get(key);
    if (!existing && version === undefined) {
      return;
    }
    this.models.delete(key);
    if (this.ready) {
      const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
      if (open) {
        this.loadDocument(open).catch(() => undefined);
      } else {
        this.removeFromIndexes(key);
      }
    }
  }

  private removeFromIndexes(uri: string): void {
    this.rebuildIndexes();
  }

  private async loadDocument(document: vscode.TextDocument): Promise<void> {
    if (!this.isSupportedDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    if (this.models.get(key)?.version === document.version) {
      return;
    }
    try {
      const model = parseSourceFile(key, document.uri.fsPath, document.getText());
      this.models.set(key, { model, version: document.version });
      this.rebuildIndexes();
    } catch (error) {
      this.log(`Load document failed: ${key}: ${String(error)}`);
    }
  }

  private async ensureModel(uri: vscode.Uri): Promise<CFileModel | undefined> {
    const key = uri.toString();
    const existing = this.models.get(key);
    if (existing) {
      const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
      if (open && open.version !== existing.version) {
        await this.loadDocument(open);
      }
      return this.models.get(key)?.model;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await this.loadDocument(document);
      return this.models.get(key)?.model;
    } catch (error) {
      this.log(`Open document failed: ${key}: ${String(error)}`);
      return undefined;
    }
  }

  private rebuildIndexes(): void {
    this.nameIndex = new Map();
    this.occurrenceIndex = new Map();
    const addName = (name: string, entry: IndexedDecl): void => {
      if (!name) {
        return;
      }
      const list = this.nameIndex.get(name);
      if (list) {
        list.push(entry);
      } else {
        this.nameIndex.set(name, [entry]);
      }
    };
    for (const { model } of this.models.values()) {
      for (const decl of model.decls) {
        addName(decl.name, { decl, model });
        if (decl.members) {
          for (const member of decl.members) {
            addName(member.name, { decl: member, model });
          }
        }
      }
      for (let wordIndex = 0; wordIndex < model.words.length; wordIndex += 1) {
        const name = model.words[wordIndex].name;
        const list = this.occurrenceIndex.get(name);
        if (list) {
          list.models.push(model);
          list.wordIndexes.push(wordIndex);
        } else {
          this.occurrenceIndex.set(name, { models: [model], wordIndexes: [wordIndex] });
        }
      }
    }
  }

  /* -------------------------------------------------------------- resolution */

  async resolveAt(
    uri: vscode.Uri,
    line: number,
    character: number,
    options: { enclosing?: boolean; word?: string } = {},
  ): Promise<CResolution | undefined> {
    await this.ensureIndexed();
    const model = await this.ensureModel(uri);
    if (!model) {
      return undefined;
    }
    if (options.enclosing) {
      const owner = this.ownerAt(model, line);
      if (owner) {
        const decl = model.decls.find((entry) => (
          entry.name === owner.name && entry.kind === owner.kind
          && (entry.kind !== 'function' || entry.isDefinition)
        ));
        if (decl) {
          return {
            decl,
            model,
            alternatives: [decl],
            word: decl.name,
          };
        }
      }
    }
    // Exact declaration name position (including struct / enum members).
    const exact = this.findDeclAt(model.decls, line, character)
      ?? model.decls
        .filter((decl) => decl.line === line
          && character >= decl.nameStart
          && character <= decl.nameEnd)
        .sort((a, b) => (a.nameEnd - a.nameStart) - (b.nameEnd - b.nameStart))[0];
    if (exact) {
      return {
        decl: exact,
        model,
        alternatives: this.alternativesFor(exact, model),
        word: exact.name,
      };
    }
    // Member access (`p->state`, `cfg.state`, `(*p).state`).
    const member = model.memberAccesses.find((entry) => (
      entry.line === line
      && character >= entry.memberStart
      && character <= entry.memberEnd
    ));
    if (member) {
      const ownerResolution = this.resolveNameInModel(model, member.owner, uri.toString(), line);
      if (ownerResolution) {
        const target = this.resolveTypeTarget(ownerResolution.decl);
        const field = target.decl?.members?.find((entry) => (
          entry.name === member.member || entry.name.endsWith(`.${member.member}`)
        ));
        if (field) {
          return {
            decl: field,
            model: target.model ?? model,
            alternatives: [field],
            word: member.member,
            memberAccess: {
              ownerName: member.owner,
              member: member.member,
              operator: member.operator,
            },
          };
        }
      }
      const fallback = this.lookupByName(member.member, uri.toString(), line);
      if (fallback) {
        return {
          ...fallback,
          memberAccess: {
            ownerName: member.owner,
            member: member.member,
            operator: member.operator,
          },
        };
      }
    }
    const lineText = model.lines[line] ?? '';
    const word = options.word ?? findWordAtLine(lineText, character)?.word;
    if (!word) {
      return undefined;
    }
    const resolution = this.resolveNameInModel(model, word, uri.toString(), line);
    if (resolution) {
      return resolution;
    }
    return this.lookupByName(word, uri.toString(), line);
  }

  private findDeclAt(decls: CDecl[], line: number, character: number): CDecl | undefined {
    for (const decl of decls) {
      if (decl.line === line && character >= decl.nameStart && character <= decl.nameEnd) {
        return decl;
      }
      if (decl.members) {
        const nested = this.findDeclAt(decl.members, line, character);
        if (nested) {
          return nested;
        }
      }
    }
    return undefined;
  }

  resolveNameInModel(
    model: CFileModel,
    word: string,
    uri: string,
    line: number,
  ): CResolution | undefined {
    const local = model.decls
      .filter((decl) => decl.name === word)
      .sort((a, b) => scoreDecl(b, model, uri, line) - scoreDecl(a, model, uri, line))[0];
    if (!local) {
      return undefined;
    }
    return {
      decl: local,
      model,
      alternatives: this.alternativesFor(local, model),
      word,
    };
  }

  lookupByName(word: string, uri: string, line: number): CResolution | undefined {
    const candidates = this.nameIndex.get(word);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    const scored = [...candidates].sort((a, b) => {
      const modelA = a.model;
      const modelB = b.model;
      return scoreDecl(b.decl, modelB, uri, line) - scoreDecl(a.decl, modelA, uri, line);
    });
    const best = scored[0];
    return {
      decl: best.decl,
      model: best.model,
      alternatives: this.alternativesFor(best.decl, best.model),
      word,
    };
  }

  private alternativesFor(decl: CDecl, model: CFileModel): CDecl[] {
    const candidates = this.nameIndex.get(decl.name) ?? [];
    return candidates
      .filter((entry) => isSameKindFamily(entry.decl.kind, decl.kind))
      .map((entry) => entry.decl)
      .filter((entry, index, list) => list.findIndex((other) => declKey(other) === declKey(entry)) === index);
  }

  private resolveNameInModelOnly(model: CFileModel, word: string, uri: string, line: number): CDecl | undefined {
    return model.decls
      .filter((decl) => decl.name === word)
      .sort((a, b) => scoreDecl(b, model, uri, line) - scoreDecl(a, model, uri, line))[0];
  }

  /* ---------------------------------------------------------------- pairing */

  definitionOf(decl: CDecl, model: CFileModel): { decl: CDecl; model: CFileModel } {
    if (decl.isDefinition) {
      return { decl, model };
    }
    const fileScoped = /\bstatic\b/.test(decl.storage)
      && (decl.kind === 'function' || decl.kind === 'variable');
    const candidates = (this.nameIndex.get(decl.name) ?? [])
      .filter((entry) => isSameKindFamily(entry.decl.kind, decl.kind)
        && entry.decl.isDefinition
        && (!fileScoped || entry.decl.fileUri === decl.fileUri))
      .sort((a, b) => {
        const aSame = folderOf(a.decl.fileUri) === folderOf(model.uri) ? 1 : 0;
        const bSame = folderOf(b.decl.fileUri) === folderOf(model.uri) ? 1 : 0;
        if (aSame !== bSame) {
          return bSame - aSame;
        }
        const aHeader = isHeaderPath(a.decl.fileUri) ? 1 : 0;
        const bHeader = isHeaderPath(b.decl.fileUri) ? 1 : 0;
        if (aHeader !== bHeader) {
          return aHeader - bHeader;
        }
        return a.decl.fileUri.localeCompare(b.decl.fileUri);
      });
    return candidates[0] ?? { decl, model };
  }

  declarationOf(decl: CDecl, model: CFileModel): { decl: CDecl; model: CFileModel } | undefined {
    if (decl.kind === 'macro' || decl.kind === 'field' || decl.kind === 'enumMember') {
      return undefined;
    }
    const fileScoped = /\bstatic\b/.test(decl.storage)
      && (decl.kind === 'function' || decl.kind === 'variable');
    const candidates = (this.nameIndex.get(decl.name) ?? [])
      .filter((entry) => (
        isSameKindFamily(entry.decl.kind, decl.kind)
        && !entry.decl.isDefinition
        && declKey(entry.decl) !== declKey(decl)
        && (!fileScoped || entry.decl.fileUri === decl.fileUri)
      ))
      .sort((a, b) => {
        const headerScore = Number(isHeaderPath(b.decl.fileUri)) - Number(isHeaderPath(a.decl.fileUri));
        return headerScore !== 0
          ? headerScore
          : a.decl.fileUri.localeCompare(b.decl.fileUri);
      });
    if (candidates.length === 0) {
      return undefined;
    }
    return { decl: candidates[0].decl, model: candidates[0].model };
  }

  /* ------------------------------------------------------------------ types */

  resolveTypeTarget(decl: CDecl | undefined, visited = 0): CTypeTarget {
    if (!decl || visited > 8) {
      return { name: '', isPointer: false, aliasPointer: false };
    }
    if (decl.kind === 'struct' || decl.kind === 'union' || decl.kind === 'enum') {
      return {
        name: decl.name,
        decl,
        model: this.modelOfDecl(decl),
        isPointer: decl.isPointer,
        aliasPointer: false,
      };
    }
    const baseType = (decl.baseType ?? '').trim();
    if (!baseType) {
      return { name: '', isPointer: decl.isPointer, aliasPointer: false };
    }
    const candidates = this.nameIndex.get(stripTypePrefix(baseType)) ?? [];
    const target = candidates.find((entry) => (
      entry.decl.kind === 'typedef'
      || entry.decl.kind === 'struct'
      || entry.decl.kind === 'union'
      || entry.decl.kind === 'enum'
    ));
    if (!target) {
      return {
        name: baseType,
        isPointer: decl.isPointer,
        aliasPointer: false,
      };
    }
    if (target.decl.kind === 'typedef') {
      const inner = this.resolveTypeTarget(target.decl, visited + 1);
      return {
        name: inner.decl?.name ?? target.decl.name,
        decl: inner.decl ?? target.decl,
        model: inner.model ?? target.model,
        isPointer: decl.isPointer || target.decl.isPointer || inner.isPointer,
        aliasPointer: target.decl.isPointer || inner.aliasPointer,
      };
    }
    return {
      name: target.decl.name,
      decl: target.decl,
      model: target.model,
      isPointer: decl.isPointer || target.decl.isPointer,
      aliasPointer: false,
    };
  }

  modelOfUri(uri: string): CFileModel | undefined {
    return this.models.get(uri)?.model;
  }

  private modelOfDecl(decl: CDecl): CFileModel | undefined {
    return this.models.get(decl.fileUri)?.model;
  }

  membersOf(decl: CDecl): { members: CDecl[]; model?: CFileModel } {
    if (decl.kind === 'enum') {
      return { members: decl.members ?? [], model: this.modelOfDecl(decl) };
    }
    if (decl.kind === 'struct' || decl.kind === 'union') {
      return { members: decl.members ?? [], model: this.modelOfDecl(decl) };
    }
    if (decl.kind === 'typedef' || decl.kind === 'variable' || decl.kind === 'field') {
      const target = this.resolveTypeTarget(decl);
      if (target.decl) {
        return {
          members: target.decl.members ?? [],
          model: target.model ?? this.modelOfDecl(target.decl),
        };
      }
    }
    return { members: [] };
  }

  instancesOf(decl: CDecl): CInstanceEntry[] {
    const typedefTarget = decl.kind === 'typedef' ? this.resolveTypeTarget(decl) : undefined;
    const targetKey = typedefTarget?.decl
      ? declKey(typedefTarget.decl)
      : declKey(decl);
    const result: CInstanceEntry[] = [];
    for (const { model } of this.models.values()) {
      for (const entry of model.decls) {
        if (entry.kind === 'variable') {
          const target = this.resolveTypeTarget(entry);
          if (target.decl && declKey(target.decl) === targetKey) {
            result.push({
              decl: entry,
              model,
              isPointer: entry.isPointer || target.isPointer,
              isField: false,
            });
          }
        }
        if (entry.members) {
          for (const member of entry.members) {
            if (member.kind !== 'field') {
              continue;
            }
            const target = this.resolveTypeTarget(member);
            if (target.decl && declKey(target.decl) === targetKey) {
              result.push({
                decl: member,
                model,
                isPointer: member.isPointer || target.isPointer,
                isField: true,
              });
            }
          }
        }
      }
    }
    return result.sort((a, b) => a.decl.name.localeCompare(b.decl.name));
  }

  aliasesOf(decl: CDecl): Array<{ decl: CDecl; model: CFileModel }> {
    const targetKey = declKey(decl);
    const result: Array<{ decl: CDecl; model: CFileModel }> = [];
    for (const { model } of this.models.values()) {
      for (const entry of model.decls) {
        if (entry.kind !== 'typedef') {
          continue;
        }
        const target = this.resolveTypeTarget(entry);
        if (target.decl && declKey(target.decl) === targetKey) {
          result.push({ decl: entry, model });
        }
      }
    }
    return result.sort((a, b) => a.decl.name.localeCompare(b.decl.name));
  }

  /* ------------------------------------------------------------- references */

  referencesOf(decl: CDecl): CReferenceEntry[] {
    const occurrences = this.occurrenceIndex.get(decl.name)
      ?? { models: [] as CFileModel[], wordIndexes: [] as number[] };
    const sameNameDecls = (this.nameIndex.get(decl.name) ?? [])
      .filter((entry) => isSameKindFamily(entry.decl.kind, decl.kind))
      .map((entry) => entry.decl);
    const result: CReferenceEntry[] = [];
    // `static` functions and variables are file scoped in C: references of a
    // same-named static symbol in another translation unit are unrelated.
    const fileScoped = /\bstatic\b/.test(decl.storage)
      && (decl.kind === 'function' || decl.kind === 'variable');
    for (let index = 0; index < occurrences.models.length; index += 1) {
      const model = occurrences.models[index];
      const word = model.words[occurrences.wordIndexes[index]];
      if (!word) {
        continue;
      }
      if (fileScoped && model.uri !== decl.fileUri) {
        continue;
      }
      const isDeclarationSite = sameNameDecls.some((entry) => (
        entry.line === word.line
        && word.character >= entry.nameStart
        && word.character <= entry.nameEnd
      ));
      if (isDeclarationSite) {
        const declaration = sameNameDecls.find((entry) => entry.line === word.line
          && word.character >= entry.nameStart
          && word.character <= entry.nameEnd);
        if (declaration && declKey(declaration) === declKey(decl)) {
          continue;
        }
        result.push({
          location: wordLocation(model, word),
          role: 'declaration',
          lineText: model.lines[word.line] ?? '',
          owner: undefined,
          ownerModel: model,
          ownerName: '声明',
        });
        continue;
      }
      const lineText = model.lines[word.line] ?? '';
      const before = lineText.slice(0, word.character);
      if (decl.kind === 'variable') {
        // Member access belongs to the struct field, not to a same-named var.
        if (/(?:\.|->)\s*$/.test(before)) {
          continue;
        }
      }
      if (decl.kind === 'field' && !/(?:\.|->)\s*$/.test(before)) {
        continue;
      }
      const role = model.isAssembly
        ? asmRole(model, word.line, word.character)
        : classifyCUse(lineText, word.character, word.endCharacter, decl.kind, Boolean(decl.isFunctionLikeMacro));
      const owner = this.ownerOf(model, word.line);
      result.push({
        location: wordLocation(model, word),
        role,
        lineText,
        owner: owner?.decl,
        ownerModel: owner?.model,
        ownerName: owner?.decl.name ?? '',
      });
    }
    return result;
  }

  declarationsOf(decl: CDecl): CDeclarationEntry[] {
    const fileScoped = /\bstatic\b/.test(decl.storage)
      && (decl.kind === 'function' || decl.kind === 'variable');
    const entries = (this.nameIndex.get(decl.name) ?? [])
      .filter((entry) => isSameKindFamily(entry.decl.kind, decl.kind)
        && (!fileScoped || entry.decl.fileUri === decl.fileUri))
      .map((entry) => ({
        decl: entry.decl,
        model: entry.model,
        role: entry.decl.isDefinition ? 'definition' as const : 'declaration' as const,
      }));
    return entries.sort((a, b) => (
      a.decl.fileUri.localeCompare(b.decl.fileUri) || a.decl.line - b.decl.line
    ));
  }

  calleesOf(decl: CDecl): Array<{ decl: CDecl; model: CFileModel; count: number }> {
    const model = this.modelOfDecl(decl);
    if (!model) {
      return [];
    }
    const ownerRange = decl.kind === 'label'
      ? model.owners.find((entry) => entry.name === decl.name && entry.kind === 'label')
      : undefined;
    const startLine = decl.bodyStartLine ?? ownerRange?.startLine ?? decl.line;
    const endLine = decl.bodyEndLine ?? ownerRange?.endLine ?? decl.endLine;
    const groups = new Map<string, { decl: CDecl; model: CFileModel; count: number }>();
    const calls = model.isAssembly
      ? model.asmRefs.filter((entry) => entry.kind === 'call')
      : model.calls;
    for (const call of calls) {
      if (call.line < startLine || call.line > endLine) {
        continue;
      }
      if (call.line === decl.line
        && call.character >= decl.nameStart
        && call.character <= decl.nameEnd) {
        continue;
      }
      const local = this.resolveNameInModelOnly(model, call.name, model.uri, call.line);
      const target = local && ['function', 'prototype', 'macro', 'label'].includes(local.kind)
        ? { decl: local, model }
        : this.lookupByName(call.name, model.uri, call.line);
      if (!target) {
        continue;
      }
      if (!['function', 'prototype', 'macro', 'label'].includes(target.decl.kind)) {
        continue;
      }
      const definition = this.definitionOf(target.decl, target.model);
      const key = declKey(definition.decl);
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(key, { decl: definition.decl, model: definition.model, count: 1 });
      }
    }
    return [...groups.values()].sort((a, b) => a.decl.name.localeCompare(b.decl.name));
  }

  memberUsesOf(decl: CDecl): CMemberUseEntry[] {
    const groups = new Map<string, CMemberUseEntry>();
    for (const { model } of this.models.values()) {
      for (const access of model.memberAccesses) {
        if (access.owner !== decl.name) {
          continue;
        }
        const localOwner = this.resolveNameInModelOnly(model, access.owner, model.uri, access.line);
        const resolvedOwner = localOwner
          ? { decl: localOwner, model }
          : this.lookupByName(access.owner, model.uri, access.line);
        const ownerKey = resolvedOwner
          ? declKey(this.definitionOf(resolvedOwner.decl, resolvedOwner.model).decl)
          : '';
        if (ownerKey && ownerKey !== declKey(decl)) {
          continue;
        }
        const lineText = model.lines[access.line] ?? '';
        const role = classifyMemberUse(lineText, access.memberEnd);
        const key = `${access.member}:${access.operator}`;
        let group = groups.get(key);
        if (!group) {
          const target = this.resolveTypeTarget(decl);
          const field = target.decl?.members?.find((entry) => (
            entry.name === access.member || entry.name.endsWith(`.${access.member}`)
          ));
          group = {
            member: access.member,
            operator: access.operator,
            field,
            sites: [],
          };
          groups.set(key, group);
        }
        group.sites.push({
          location: {
            uri: model.uri,
            startLine: access.line,
            startCharacter: access.memberStart,
            endLine: access.line,
            endCharacter: access.memberEnd,
          },
          role,
        });
      }
    }
    return [...groups.values()].sort((a, b) => a.member.localeCompare(b.member));
  }

  /* --------------------------------------------------------------- searching */

  async search(pattern: string, options: SearchOptions): Promise<CSearchResult> {
    await this.ensureIndexed();
    const regex = buildSearchRegExp(pattern, options);
    const matches: CSearchMatch[] = [];
    let total = 0;
    let truncated = false;
    const collect = (uri: string, path: string, lines: string[]): void => {
      const fileName = path.split(/[\\/]/).pop() ?? path;
      for (let line = 0; line < lines.length; line += 1) {
        const text = lines[line];
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          total += 1;
          if (matches.length < MAX_SEARCH_RESULTS) {
            matches.push({
              uri,
              fileName,
              line,
              character: match.index,
              endCharacter: match.index + Math.max(1, match[0].length),
              text: text.trim(),
            });
          } else {
            truncated = true;
          }
          if (match[0].length === 0) {
            regex.lastIndex += 1;
          }
        }
      }
    };
    const config = vscode.workspace.getConfiguration('sourceInsight');
    if (config.get<boolean>('enableProjectIndex') === false) {
      // Index disabled: search the workspace files directly instead of the
      // (mostly empty) in-memory symbol database.
      const files = await vscode.workspace.findFiles(
        '**/*.{c,h,s,S,asm,inc}',
        '{**/node_modules/**,**/build/**,**/out/**,**/dist/**,**/.git/**,**/Debug/**,**/Release/**}',
        40000,
      );
      for (const uri of files) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text = new TextDecoder('utf-8').decode(bytes);
          collect(uri.toString(), uri.fsPath, text.split(/\r?\n/));
        } catch {
          // Ignore unreadable files.
        }
      }
      return { pattern, matches, total, truncated };
    }
    const models = [...this.models.values()].map((entry) => entry.model)
      .sort((a, b) => a.path.localeCompare(b.path));
    for (const model of models) {
      collect(model.uri, model.path, model.lines);
    }
    return { pattern, matches, total, truncated };
  }

  /* ---------------------------------------------------------------- helpers */

  private ownerAt(model: CFileModel, line: number): { name: string; kind: CKind } | undefined {
    const range = model.owners
      .filter((entry) => line >= entry.startLine && line <= entry.endLine)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
    return range ? { name: range.name, kind: range.kind } : undefined;
  }

  private ownerOf(
    model: CFileModel,
    line: number,
  ): { decl: CDecl; model: CFileModel } | undefined {
    const owner = this.ownerAt(model, line);
    if (!owner) {
      return undefined;
    }
    const decl = model.decls.find((entry) => entry.name === owner.name && entry.kind === owner.kind);
    if (decl) {
      return { decl, model };
    }
    // Synthesize an owner so references inside it can still be grouped.
    const range = model.owners.find((entry) => entry.name === owner.name && entry.kind === owner.kind);
    return {
      decl: {
        name: owner.name,
        kind: owner.kind,
        fileUri: model.uri,
        line: range?.startLine ?? line,
        nameStart: 0,
        nameEnd: owner.name.length,
        endLine: range?.endLine ?? line,
        endCharacter: 0,
        typeText: '',
        signature: owner.name,
        storage: '',
        isPointer: false,
        pointerLevel: 0,
        isArray: false,
        isConst: false,
        isDefinition: true,
      },
      model,
    };
  }

  stats(): { files: number; declarations: number } {
    let declarations = 0;
    for (const { model } of this.models.values()) {
      declarations += model.decls.length;
    }
    return { files: this.models.size, declarations };
  }
}

function stripTypePrefix(type: string): string {
  return type
    .replace(/^(?:struct|union|enum)\s+/, '')
    .replace(/\s*\*+$/, '')
    .replace(/\b(?:const|volatile|restrict)\b/g, '')
    .trim();
}

function wordLocation(model: CFileModel, word: CWord): SourceLocation {
  return {
    uri: model.uri,
    startLine: word.line,
    startCharacter: word.character,
    endLine: word.line,
    endCharacter: word.endCharacter,
  };
}

function asmRole(model: CFileModel, line: number, character: number): CUseRole {
  const ref = model.asmRefs.find((entry) => (
    entry.line === line
    && character >= entry.character
    && character <= entry.endCharacter
  ));
  if (!ref) {
    return 'reference';
  }
  return ref.kind === 'call' ? 'call' : 'reference';
}

function classifyMemberUse(lineText: string, memberEnd: number): 'read' | 'write' {
  const after = lineText.slice(memberEnd);
  return /^\s*(?:\[[^\]]*\]\s*)*(?:\+\+|--|[+\-*/%&|^]?=(?!=))/.test(after) ? 'write' : 'read';
}

function scoreDecl(
  decl: CDecl,
  model: CFileModel,
  fromUri: string,
  fromLine: number,
): number {
  let score = 0;
  if (decl.fileUri === fromUri) {
    score += 80;
  } else if (folderOf(decl.fileUri) === folderOf(fromUri)) {
    score += 8;
  }
  if (decl.isDefinition) {
    score += 40;
  } else {
    score += 6;
  }
  switch (decl.kind) {
    case 'function':
      score += 14;
      break;
    case 'macro':
      score += 12;
      break;
    case 'struct':
    case 'union':
    case 'enum':
      score += 10;
      break;
    case 'typedef':
      score += 8;
      break;
    case 'variable':
      score += 6;
      break;
    case 'field':
      score -= 4;
      break;
    case 'prototype':
      score += 2;
      break;
    case 'label':
      score += 10;
      break;
    default:
      break;
  }
  if (isHeaderPath(decl.fileUri)) {
    score += decl.kind === 'macro' || decl.kind === 'typedef' || decl.kind === 'struct'
      || decl.kind === 'union' || decl.kind === 'enum' ? 6 : -6;
  }
  if (model.uri === fromUri) {
    const distance = Math.min(Math.abs(decl.line - fromLine), 200);
    score += Math.max(0, 20 - distance / 10);
  }
  if (decl.name.startsWith('anon@')) {
    score -= 40;
  }
  return score;
}
