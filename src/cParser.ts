/**
 * Source Insight style C symbol parser.
 *
 * This module is deliberately free of the `vscode` module so that it can be
 * unit tested. It performs a pragmatic, declaration level parse of C / header /
 * assembly files and records the information the Relation window needs:
 *
 *   - object-like and function-like macros (#define)
 *   - typedef aliases (including pointer and function pointer aliases)
 *   - struct / union / enum definitions and their members
 *   - function prototypes (declaration) and function definitions (body range)
 *   - global / file-scope variables (value, pointer, array, extern, static)
 *   - assembly labels and call/jump targets
 *   - identifier occurrences, call sites and `a.b` / `p->b` member accesses
 *
 * It is intentionally heuristic: C has no practical grammar for regex level
 * parsing, but the supported subset covers normal embedded C code.
 */

export type CKind =
  | 'function'
  | 'prototype'
  | 'variable'
  | 'field'
  | 'param'
  | 'struct'
  | 'union'
  | 'enum'
  | 'enumMember'
  | 'typedef'
  | 'macro'
  | 'label';

export type CUseRole = 'call' | 'read' | 'write' | 'address' | 'reference';

export interface CParam {
  name: string;
  typeText: string;
  isPointer: boolean;
}

export interface CDecl {
  name: string;
  kind: CKind;
  fileUri: string;
  line: number;
  nameStart: number;
  nameEnd: number;
  endLine: number;
  endCharacter: number;
  /** Base type text without storage modifiers, e.g. `const UINT8` or `struct Tag`. */
  typeText: string;
  /** Full declaration text (signature), used for the Context window details. */
  signature: string;
  storage: string;
  isPointer: boolean;
  pointerLevel: number;
  isArray: boolean;
  isConst: boolean;
  isDefinition: boolean;
  isAnonymous?: boolean;
  isFunctionLikeMacro?: boolean;
  macroParams?: string[];
  macroBody?: string;
  /** For a typedef: the aliased type name. For a variable: the base type name. */
  baseType?: string;
  params?: CParam[];
  /** Members for struct / union / enum. */
  members?: CDecl[];
  parentName?: string;
  tagName?: string;
  aliasName?: string;
  initText?: string;
  /** Source lines covered by a macro body or a struct body. */
  bodyStartLine?: number;
  bodyEndLine?: number;
}

export interface CWord {
  name: string;
  line: number;
  character: number;
  endCharacter: number;
}

export interface CCallSite extends CWord {
  /** `.` or `->` when this is a member function pointer call. */
  operator?: '.' | '->';
  qualifier?: string;
}

export interface CMemberAccess {
  owner: string;
  member: string;
  operator: '.' | '->';
  line: number;
  character: number;
  endCharacter: number;
  /** Character offset of the member word in the line. */
  memberStart: number;
  memberEnd: number;
  operatorStart: number;
}

export type CAsmRefKind = 'call' | 'jump' | 'data';

export interface CAsmRef {
  name: string;
  line: number;
  character: number;
  endCharacter: number;
  kind: CAsmRefKind;
}

export interface COwnerRange {
  name: string;
  kind: CKind;
  startLine: number;
  endLine: number;
}

export interface CFileModel {
  uri: string;
  path: string;
  text: string;
  lines: string[];
  isHeader: boolean;
  isAssembly: boolean;
  decls: CDecl[];
  includes: string[];
  words: CWord[];
  calls: CCallSite[];
  memberAccesses: CMemberAccess[];
  asmRefs: CAsmRef[];
  owners: COwnerRange[];
  /** Physical lines that belong to preprocessor directives. */
  directiveLines: number[];
}

export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool',
  '_Complex', '_Imaginary', '_Atomic', '_Generic', '_Alignas', '_Alignof',
  '_Static_assert', '_Noreturn', '_Thread_local', 'true', 'false', 'NULL',
  'defined', '__attribute__', '__declspec', '__asm', '__asm__', 'asm', 'typeof',
  '__typeof__', '__inline', '__restrict', '__extension__',
]);

const STORAGE_KEYWORDS = new Set([
  'extern', 'static', 'register', 'inline', 'auto', 'typedef', '_Thread_local',
]);

const C_EXTENSIONS = /\.(?:c|h|inc)$/i;
const ASM_EXTENSIONS = /\.(?:s|asm)$/i;
const HEADER_EXTENSIONS = /\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|inc)$/i;

export function isCFile(path: string): boolean {
  return C_EXTENSIONS.test(path);
}

export function isAsmFile(path: string): boolean {
  return ASM_EXTENSIONS.test(path);
}

export function isHeaderPath(path: string): boolean {
  return HEADER_EXTENSIONS.test(path);
}

export function isIndexablePath(path: string): boolean {
  return isCFile(path) || isAsmFile(path);
}

interface Tok {
  text: string;
  line: number;
  char: number;
  endChar: number;
  offset: number;
  endOffset: number;
}

class LineMap {
  readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') {
        this.starts.push(i + 1);
      }
    }
  }

  position(offset: number): { line: number; character: number } {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (this.starts[mid] <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return { line: low, character: offset - this.starts[low] };
  }
}

/** Replace comments, string and character literals with spaces, preserving newlines. */
export function maskCCode(text: string): string {
  const out = text.split('');
  let state: 'code' | 'line' | 'block' | 'single' | 'double' = 'code';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    switch (state) {
      case 'code':
        if (char === '/' && next === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 1;
          state = 'line';
        } else if (char === '/' && next === '*') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 1;
          state = 'block';
        } else if (char === '"') {
          out[i] = ' ';
          state = 'double';
        } else if (char === "'") {
          out[i] = ' ';
          state = 'single';
        }
        break;
      case 'line':
        if (char === '\n') {
          state = 'code';
        } else {
          out[i] = ' ';
        }
        break;
      case 'block':
        if (char === '*' && next === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 1;
          state = 'code';
        } else if (char !== '\n') {
          out[i] = ' ';
        }
        break;
      case 'single':
      case 'double':
        if (char === '\\') {
          out[i] = ' ';
          if (next !== undefined && next !== '\n') {
            out[i + 1] = ' ';
            i += 1;
          }
        } else if (
          (state === 'single' && char === "'") ||
          (state === 'double' && char === '"')
        ) {
          out[i] = ' ';
          state = 'code';
        } else if (char !== '\n') {
          out[i] = ' ';
        }
        break;
      default:
        break;
    }
  }
  return out.join('');
}

export function collapseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSearchRegExp(pattern: string, options: SearchOptions): RegExp {
  const source = options.regex ? pattern : escapeRegExp(pattern);
  const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source;
  return new RegExp(wrapped, options.caseSensitive ? 'g' : 'gi');
}

export function findWordAtLine(
  lineText: string,
  character: number,
): { word: string; start: number; end: number } | undefined {
  const wordPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return { word: match[0], start, end };
    }
    if (start > character) {
      break;
    }
  }
  return undefined;
}

/** Classify a variable / field occurrence as read, write or address-of. */
export function classifyVariableUse(
  lineText: string,
  start: number,
  end: number,
): 'read' | 'write' | 'address' {
  const before = lineText.slice(0, start);
  const after = lineText.slice(end);
  if (/[&](?!&)\s*$/.test(before)) {
    if (/\b(?:memset|memcpy|memmove|strcpy|strncpy|sprintf|snprintf|scanf|sscanf|fscanf)\s*\(\s*(?:\([^)]*\)\s*)?$/.test(before)) {
      return 'write';
    }
    return 'address';
  }
  if (/(?:\+\+|--)\s*$/.test(before)) {
    return 'write';
  }
  // Member access (`x.a` / `p->a`) reads the variable / pointer itself, even
  // when the member is being assigned. Field writes are tracked separately.
  if (/^\s*(?:\[[^\]]*\]\s*)*(?:\.|->)/.test(after)) {
    return 'read';
  }
  if (/^\s*(?:\[[^\]]*\]\s*)*(?:\+\+|--|[+\-*/%&|^]?=(?!=))/.test(after)) {
    return 'write';
  }
  return 'read';
}

export function classifyCUse(
  lineText: string,
  start: number,
  end: number,
  kind: CKind,
  isFunctionLikeMacro = false,
): CUseRole {
  const before = lineText.slice(0, start);
  const after = lineText.slice(end);
  if (kind === 'function' || kind === 'prototype' || kind === 'label') {
    if (/^\s*\(/.test(after)) {
      return 'call';
    }
    if (/[&](?!&)\s*$/.test(before)) {
      return 'address';
    }
    return 'reference';
  }
  if (kind === 'macro') {
    if (isFunctionLikeMacro && /^\s*\(/.test(after)) {
      return 'call';
    }
    return 'reference';
  }
  if (kind === 'struct' || kind === 'union' || kind === 'enum' || kind === 'typedef') {
    return 'reference';
  }
  return classifyVariableUse(lineText, start, end);
}

/* ------------------------------------------------------------------ parser */

export function parseSourceFile(uri: string, path: string, text: string): CFileModel {
  if (isAsmFile(path)) {
    return parseAssemblyFile(uri, path, text);
  }
  return new CFileParser(uri, path, text).parse();
}

class CFileParser {
  private readonly map: LineMap;
  private readonly masked: string;
  private readonly lines: string[];
  private readonly isHeader: boolean;
  private readonly decls: CDecl[] = [];
  private readonly includes: string[] = [];
  private readonly directiveLineSet = new Set<number>();

  constructor(
    private readonly uri: string,
    private readonly path: string,
    private readonly text: string,
  ) {
    this.map = new LineMap(text);
    this.masked = maskCCode(text);
    this.lines = text.split(/\r?\n/);
    this.isHeader = isHeaderPath(path);
  }

  parse(): CFileModel {
    this.parsePreprocessor();
    const parseText = this.blankDirectiveLines();
    const tokens = this.tokenize(parseText);
    this.parseTopLevel(tokens);
    const uses = this.scanUses();
    const owners = this.buildOwners();
    return {
      uri: this.uri,
      path: this.path,
      text: this.text,
      lines: this.lines,
      isHeader: this.isHeader,
      isAssembly: false,
      decls: this.decls,
      includes: this.includes,
      words: uses.words,
      calls: uses.calls,
      memberAccesses: uses.memberAccesses,
      asmRefs: [],
      owners,
      directiveLines: [...this.directiveLineSet],
    };
  }

  private parsePreprocessor(): void {
    for (let index = 0; index < this.lines.length; index += 1) {
      const line = this.lines[index];
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('#')) {
        continue;
      }
      const directive = /^#\s*(include|define|undef|if|ifdef|ifndef|else|elif|endif|pragma|error|warning)\b/.exec(trimmed);
      if (!directive) {
        continue;
      }
      const keyword = directive[1];
      if (keyword === 'include') {
        const included = /^#\s*include\s*[<"]([^>"]+)[>"]/.exec(trimmed);
        if (included) {
          this.includes.push(included[1]);
        }
        this.directiveLineSet.add(index);
        continue;
      }
      if (keyword !== 'define') {
        this.directiveLineSet.add(index);
        continue;
      }
      let endLine = index;
      let raw = line;
      while (/\\\s*$/.test(raw) && endLine + 1 < this.lines.length) {
        endLine += 1;
        raw = `${raw.slice(0, -1)}\n${this.lines[endLine]}`;
        this.directiveLineSet.add(endLine);
      }
      this.directiveLineSet.add(index);
      const define = /^\s*#\s*define\s+([A-Za-z_$][A-Za-z0-9_$]*)(.*)$/.exec(raw);
      if (!define) {
        continue;
      }
      const name = define[1];
      const rest = define[2];
      const functionLike = rest.startsWith('(');
      let params: string[] | undefined;
      let body = rest;
      if (functionLike) {
        const close = this.findClosingParenInText(rest, 0);
        if (close >= 0) {
          params = rest
            .slice(1, close)
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
          body = rest.slice(close + 1);
        }
      }
      const nameIndex = line.indexOf(name);
      this.decls.push({
        name,
        kind: 'macro',
        fileUri: this.uri,
        line: index,
        nameStart: Math.max(0, nameIndex),
        nameEnd: Math.max(0, nameIndex) + name.length,
        endLine,
        endCharacter: 0,
        typeText: '',
        signature: collapseText(raw),
        storage: '',
        isPointer: false,
        pointerLevel: 0,
        isArray: false,
        isConst: false,
        isDefinition: true,
        isFunctionLikeMacro: functionLike,
        macroParams: params,
        macroBody: collapseText(body.replace(/\\\s*\n/g, ' ')),
        bodyStartLine: index,
        bodyEndLine: endLine,
      });
    }
  }

  private findClosingParenInText(text: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < text.length; i += 1) {
      if (text[i] === '(') {
        depth += 1;
      } else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  private blankDirectiveLines(): string {
    if (this.directiveLineSet.size === 0) {
      return this.masked;
    }
    const chars = this.masked.split('');
    for (const line of this.directiveLineSet) {
      const start = this.map.starts[line] ?? 0;
      const end = line + 1 < this.map.starts.length
        ? this.map.starts[line + 1] - 1
        : this.masked.length;
      for (let i = start; i < end; i += 1) {
        if (chars[i] !== '\n') {
          chars[i] = ' ';
        }
      }
    }
    return chars.join('');
  }

  private tokenize(text: string): Tok[] {
    const tokens: Tok[] = [];
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(char)) {
        let end = index + 1;
        while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) {
          end += 1;
        }
        tokens.push(this.makeToken(text, index, end));
        index = end;
        continue;
      }
      if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
        let end = index + 1;
        while (end < text.length && /[0-9A-Za-z_.]/.test(text[end])) {
          end += 1;
        }
        tokens.push(this.makeToken(text, index, end));
        index = end;
        continue;
      }
      tokens.push(this.makeToken(text, index, index + 1));
      index += 1;
    }
    return tokens;
  }

  private makeToken(text: string, start: number, end: number): Tok {
    const position = this.map.position(start);
    return {
      text: text.slice(start, end),
      line: position.line,
      char: position.character,
      endChar: position.character + (end - start),
      offset: start,
      endOffset: end,
    };
  }

  private parseTopLevel(tokens: Tok[]): void {
    this.currentTokens = tokens;
    let index = 0;
    let guard = 0;
    while (index < tokens.length && guard < 200000) {
      guard += 1;
      const text = tokens[index].text;
      if (text === ';' || text === '}') {
        index += 1;
        continue;
      }
      // `__packed struct X { ... }` / `MY_API typedef struct ...`
      if (
        isIdentifier(text)
        && !isKeyword(text)
        && ['struct', 'union', 'enum', 'typedef'].includes(tokens[index + 1]?.text)
      ) {
        index += 1;
        continue;
      }
      if (text === 'typedef') {
        index = this.parseTypedef(tokens, index);
        continue;
      }
      if (text === 'struct' || text === 'union' || text === 'enum') {
        index = this.parseTagStatement(tokens, index);
        continue;
      }
      if (text === 'extern' && tokens[index + 1]?.text === ';') {
        index += 2;
        continue;
      }
      index = this.parseGeneralStatement(tokens, index);
    }
  }

  private parseTypedef(tokens: Tok[], start: number): number {
    const next = start + 1;
    const head = tokens[next]?.text;
    if (head === 'struct' || head === 'union' || head === 'enum') {
      const spec = this.parseTypeSpec(tokens, next);
      const end = this.findSemicolon(tokens, spec ? spec.next : next);
      if (!spec) {
        return end + 1;
      }
      const aliasParts = spec.next < end
        ? this.splitTopLevel(tokens, spec.next, end, ',')
        : [];
      const aliases = aliasParts
        .map(([a, b]) => this.parseDeclarator(tokens, a, b))
        .filter((entry): entry is DeclaratorInfo => Boolean(entry));
      let typeName = spec.tag;
      if (!typeName) {
        const valueAlias = aliases.find((entry) => !entry.isPointer);
        typeName = valueAlias?.name ?? `anon@${tokens[start].line + 1}`;
      }
      const fallback = aliases[0]
        ? { line: aliases[0].line, character: aliases[0].nameStart }
        : undefined;
      this.addTypeDeclaration(spec, typeName, tokens[start].line, fallback);
      for (const alias of aliases) {
        if (!spec.tag && !alias.isPointer && alias.name === typeName) {
          continue;
        }
        this.addTypedefAlias(
          alias,
          this.typeNameForSpec(spec, typeName),
          tokens[start].line,
          end,
        );
      }
      return end + 1;
    }
    const terminator = this.findStatementEnd(tokens, start);
    const end = terminator.index;
    const parts = this.splitTopLevel(tokens, next, end, ',');
    for (const [a, b] of parts) {
      const declarator = this.parseDeclarator(tokens, a, b);
      if (!declarator) {
        continue;
      }
      this.addTypedefAlias(declarator, declarator.baseTypeText, tokens[start].line, end);
    }
    return end + 1;
  }

  private typeNameForSpec(
    spec: TypeSpec,
    fallback: string,
  ): string {
    return spec.tag ? `${spec.kind} ${spec.tag}` : fallback;
  }

  private addTypedefAlias(
    declarator: DeclaratorInfo,
    baseType: string,
    statementLine: number,
    endLine: number,
  ): void {
    this.decls.push({
      name: declarator.name,
      kind: 'typedef',
      fileUri: this.uri,
      line: declarator.line,
      nameStart: declarator.nameStart,
      nameEnd: declarator.nameEnd,
      endLine,
      endCharacter: 0,
      typeText: declarator.typeText || baseType,
      signature: declarator.signature,
      storage: '',
      isPointer: declarator.isPointer,
      pointerLevel: declarator.pointerLevel,
      isArray: declarator.isArray,
      isConst: declarator.isConst,
      isDefinition: true,
      baseType: baseType || declarator.typeText,
      aliasName: declarator.name,
      bodyStartLine: statementLine,
    });
  }

  private parseTagStatement(tokens: Tok[], start: number): number {
    const spec = this.parseTypeSpec(tokens, start);
    if (!spec) {
      return start + 1;
    }
    let index = spec.next;
    if (tokens[index]?.text === ';') {
      const name = spec.tag ?? `anon@${tokens[start].line + 1}`;
      this.addTypeDeclaration(spec, name, tokens[start].line);
      return index + 1;
    }
    // `struct Tag f(void) { ... }` / `struct Tag f(void);` – a function whose
    // return type uses a struct / union / enum specifier.
    const firstDeclarator = tokens[index];
    if (
      spec.tag
      && firstDeclarator
      && isIdentifier(firstDeclarator.text)
      && tokens[index + 1]?.text === '('
    ) {
      const terminator = this.findStatementEnd(tokens, index);
      const candidate = this.findFunctionCandidate(tokens, start, terminator.index);
      if (candidate) {
        const baseType = `${spec.kind} ${spec.tag}`;
        if (spec.body) {
          this.addTypeDeclaration(spec, spec.tag, tokens[start].line);
        }
        if (terminator.kind === 'brace') {
          const close = this.findMatching(tokens, terminator.index);
          this.addFunction(
            candidate,
            tokens,
            index,
            terminator.index,
            true,
            close,
            baseType,
          );
          return close < 0 ? tokens.length : close + 1;
        }
        this.addFunction(
          candidate,
          tokens,
          index,
          terminator.index,
          false,
          -1,
          baseType,
        );
        return terminator.index + 1;
      }
    }
    const end = this.findSemicolon(tokens, index);
    const parts = this.splitTopLevel(tokens, index, end, ',');
    const declarators = parts
      .map(([a, b]) => this.parseDeclarator(tokens, a, b))
      .filter((entry): entry is DeclaratorInfo => Boolean(entry));
    let typeName = spec.tag;
    if (!typeName) {
      const value = declarators.find((entry) => !entry.isPointer);
      typeName = value?.name ?? declarators[0]?.name ?? `anon@${tokens[start].line + 1}`;
    }
    const fallback = declarators[0]
      ? { line: declarators[0].line, character: declarators[0].nameStart }
      : undefined;
    this.addTypeDeclaration(spec, typeName, tokens[start].line, fallback);
    for (const declarator of declarators) {
      this.addVariableFromDeclarator(
        declarator,
        `${spec.kind} ${typeName}`,
        tokens[start].line,
        end,
      );
    }
    return end + 1;
  }

  private addTypeDeclaration(
    spec: TypeSpec,
    name: string,
    statementLine: number,
    fallback?: { line: number; character: number },
  ): void {
    const nameTok = spec.tagToken ?? {
      text: name,
      line: statementLine,
      char: 0,
      endChar: name.length,
      offset: 0,
      endOffset: 0,
    };
    const position = spec.tagToken
      ? { line: nameTok.line, character: nameTok.char }
      : fallback ?? this.findAnonymousNamePosition(statementLine, name);
    const members = spec.body
      ? spec.kind === 'enum'
        ? this.parseEnumMembers(spec.body.start, spec.body.end, name)
        : this.parseStructMembers(spec.body.start, spec.body.end, name)
      : undefined;
    const bodyLines = spec.body
      ? { start: spec.body.startLine, end: spec.body.endLine }
      : undefined;
    this.decls.push({
      name,
      kind: spec.kind as CKind,
      fileUri: this.uri,
      line: position.line,
      nameStart: position.character,
      nameEnd: position.character + name.length,
      endLine: bodyLines?.end ?? position.line,
      endCharacter: 0,
      typeText: spec.kind,
      signature: spec.body
        ? `${spec.kind} ${spec.tag ?? '(匿名)'} { ... }`
        : `${spec.kind} ${spec.tag ?? ''}`.trim(),
      storage: '',
      isPointer: false,
      pointerLevel: 0,
      isArray: false,
      isConst: false,
      isDefinition: Boolean(spec.body),
      isAnonymous: !spec.tag,
      tagName: spec.tag,
      members,
      bodyStartLine: bodyLines?.start,
      bodyEndLine: bodyLines?.end,
    });
  }

  private findAnonymousNamePosition(
    line: number,
    name: string,
  ): { line: number; character: number } {
    const text = this.lines[line] ?? '';
    const index = text.indexOf(name);
    return { line, character: index >= 0 ? index : 0 };
  }

  private parseTypeSpec(tokens: Tok[], start: number): TypeSpec | undefined {
    const kindTok = tokens[start];
    const kind = kindTok.text;
    if (kind !== 'struct' && kind !== 'union' && kind !== 'enum') {
      return undefined;
    }
    let index = start + 1;
    let tagToken: Tok | undefined;
    if (tokens[index] && isIdentifier(tokens[index].text) && !isKeyword(tokens[index].text)) {
      tagToken = tokens[index];
      index += 1;
    }
    // Skip attributes such as __attribute__((packed)) / __declspec(align(4)).
    // Do not treat an ordinary identifier followed by `(` as an attribute:
    // `struct Tag get_data(void)` is a function whose return type is the tag.
    while (tokens[index] && isAttributeName(tokens[index].text)
      && tokens[index + 1]?.text === '(') {
      const close = this.findMatching(tokens, index + 1);
      if (close < 0) {
        break;
      }
      index = close + 1;
    }
    if (tokens[index]?.text !== '{') {
      return { kind, tag: tagToken?.text, tagToken, next: index };
    }
    const close = this.findMatching(tokens, index);
    if (close < 0) {
      return { kind, tag: tagToken?.text, tagToken, next: tokens.length };
    }
    return {
      kind,
      tag: tagToken?.text,
      tagToken,
      next: close + 1,
      body: {
        start: index + 1,
        end: close,
        startLine: tokens[index].line,
        endLine: tokens[close].line,
      },
    };
  }

  private parseStructMembers(start: number, end: number, parentName: string): CDecl[] {
    const tokens = this.currentTokens;
    const segments = this.splitTopLevel(tokens, start, end, ';');
    const members: CDecl[] = [];
    for (const [a, b] of segments) {
      if (a >= b) {
        continue;
      }
      const first = tokens[a]?.text;
      if (first === 'struct' || first === 'union' || first === 'enum') {
        const nested = this.parseNestedMember(tokens, a, b, parentName);
        members.push(...nested);
        continue;
      }
      const declarators = this.splitTopLevel(tokens, a, b, ',')
        .map(([x, y]) => this.parseDeclarator(tokens, x, y))
        .filter((entry): entry is DeclaratorInfo => Boolean(entry));
      if (declarators.length === 0) {
        continue;
      }
      const baseType = declarators[0].typeText;
      for (const declarator of declarators) {
        const field = this.makeDeclFromDeclarator(
          declarator,
          declarator === declarators[0] ? baseType || declarator.typeText : baseType,
          'field',
          b > 0 ? tokens[b - 1].line : declarator.line,
        );
        if (field) {
          field.parentName = parentName;
          members.push(field);
        }
      }
    }
    return members;
  }

  private parseNestedMember(
    tokens: Tok[],
    start: number,
    end: number,
    parentName: string,
  ): CDecl[] {
    const spec = this.parseTypeSpec(tokens, start);
    if (!spec || !spec.body) {
      return [];
    }
    const innerParent = spec.tag ?? `${parentName}.anon`;
    const inner = spec.kind === 'enum'
      ? this.parseEnumMembers(spec.body.start, spec.body.end, innerParent)
      : this.parseStructMembers(spec.body.start, spec.body.end, innerParent);
    const declarators = spec.next < end
      ? this.splitTopLevel(tokens, spec.next, end, ',')
        .map(([a, b]) => this.parseDeclarator(tokens, a, b))
        .filter((entry): entry is DeclaratorInfo => Boolean(entry))
      : [];
    if (declarators.length === 0) {
      return inner;
    }
    const result: CDecl[] = [];
    for (const declarator of declarators) {
      const field = this.makeDeclFromDeclarator(
        declarator,
        `${spec.kind} ${spec.tag ?? '(匿名)'}`,
        'field',
        declarator.line,
      );
      if (!field) {
        continue;
      }
      field.parentName = parentName;
      field.members = inner;
      result.push(field);
      for (const entry of inner) {
        result.push({
          ...entry,
          name: `${declarator.name}.${entry.name}`,
          parentName,
        });
      }
    }
    return result;
  }

  private parseEnumMembers(start: number, end: number, parentName: string): CDecl[] {
    const tokens = this.currentTokens;
    const segments = this.splitTopLevel(tokens, start, end, ',');
    const members: CDecl[] = [];
    for (const [a, b] of segments) {
      let nameTok: Tok | undefined;
      for (let i = a; i < b; i += 1) {
        if (isIdentifier(tokens[i].text) && !isKeyword(tokens[i].text)) {
          nameTok = tokens[i];
          break;
        }
        if (tokens[i].text === '=') {
          break;
        }
      }
      if (!nameTok) {
        continue;
      }
      const valueText = (() => {
        for (let i = a; i < b; i += 1) {
          if (tokens[i].text === '=') {
            return collapseText(this.sliceTokens(tokens, i + 1, b));
          }
        }
        return undefined;
      })();
      members.push({
        name: nameTok.text,
        kind: 'enumMember',
        fileUri: this.uri,
        line: nameTok.line,
        nameStart: nameTok.char,
        nameEnd: nameTok.endChar,
        endLine: nameTok.line,
        endCharacter: nameTok.endChar,
        typeText: parentName,
        signature: valueText ? `${nameTok.text} = ${valueText}` : nameTok.text,
        storage: '',
        isPointer: false,
        pointerLevel: 0,
        isArray: false,
        isConst: true,
        isDefinition: true,
        parentName,
      });
    }
    return members;
  }

  private currentTokens: Tok[] = [];

  private parseGeneralStatement(tokens: Tok[], start: number): number {
    this.currentTokens = tokens;
    const terminator = this.findStatementEnd(tokens, start);
    if (terminator.kind === 'semi') {
      const end = terminator.index;
      const fn = this.findFunctionCandidate(tokens, start, end);
      if (fn) {
        this.addFunction(fn, tokens, start, end, false);
        return end + 1;
      }
      this.parseVariables(tokens, start, end);
      return end + 1;
    }
    if (terminator.kind === 'brace') {
      const braceIndex = terminator.index;
      const fn = this.findFunctionCandidate(tokens, start, braceIndex);
      if (fn) {
        const close = this.findMatching(tokens, braceIndex);
        this.addFunction(fn, tokens, start, braceIndex, true, close);
        return close < 0 ? tokens.length : close + 1;
      }
      const close = this.findMatching(tokens, braceIndex);
      return close < 0 ? tokens.length : close + 1;
    }
    return terminator.index + 1;
  }

  private parseVariables(tokens: Tok[], start: number, end: number): void {
    if (start >= end) {
      return;
    }
    const first = tokens[start];
    const second = tokens[start + 1];
    // File scope macro invocation / expression statement.
    if (isIdentifier(first.text) && second?.text === '(') {
      return;
    }
    const allowedLeadingWords = new Set([
      'const', 'volatile', 'unsigned', 'signed', 'short', 'long', 'int', 'char',
      'float', 'double', 'void', 'struct', 'union', 'enum', '_Bool', 'restrict',
      ...STORAGE_KEYWORDS,
    ]);
    if (isKeyword(first.text) && !allowedLeadingWords.has(first.text)) {
      return;
    }
    const declEnd = this.findTopLevelToken(tokens, start, end, '=') ?? end;
    const parts = this.splitTopLevel(tokens, start, declEnd, ',');
    const declarators = parts
      .map(([a, b]) => this.parseDeclarator(tokens, a, b))
      .filter((entry): entry is DeclaratorInfo => Boolean(entry));
    if (declarators.length === 0) {
      return;
    }
    const baseType = declarators[0].typeText;
    if (!baseType) {
      return;
    }
    for (const declarator of declarators) {
      this.addVariableFromDeclarator(declarator, baseType, tokens[start].line, end);
    }
  }

  private addVariableFromDeclarator(
    declarator: DeclaratorInfo,
    baseType: string,
    statementLine: number,
    endLine: number,
  ): void {
    const decl = this.makeDeclFromDeclarator(
      declarator,
      baseType,
      'variable',
      endLine,
    );
    if (!decl) {
      return;
    }
    const extern = /\bextern\b/.test(decl.storage);
    decl.isDefinition = !extern && !(this.isHeader && !decl.initText);
    decl.bodyStartLine = statementLine;
    this.decls.push(decl);
  }

  private makeDeclFromDeclarator(
    declarator: DeclaratorInfo,
    baseType: string,
    kind: CKind,
    endLine: number,
  ): CDecl | undefined {
    if (!declarator.name || isKeyword(declarator.name)) {
      return undefined;
    }
    const declaratorType = /[A-Za-z_]/.test(declarator.typeText)
      ? declarator.typeText
      : '';
    const typeText = normalizeTypeText(declaratorType || baseType);
    return {
      name: declarator.name,
      kind,
      fileUri: this.uri,
      line: declarator.line,
      nameStart: declarator.nameStart,
      nameEnd: declarator.nameEnd,
      endLine,
      endCharacter: 0,
      typeText,
      signature: declarator.signature,
      storage: declarator.storage,
      isPointer: declarator.isPointer,
      pointerLevel: declarator.pointerLevel,
      isArray: declarator.isArray,
      isConst: declarator.isConst,
      isDefinition: kind === 'field',
      baseType: baseTypeName(typeText),
      initText: declarator.initText,
    };
  }

  private addFunction(
    candidate: FunctionCandidate,
    tokens: Tok[],
    start: number,
    terminator: number,
    definition: boolean,
    closeBrace = -1,
    baseTypeOverride?: string,
  ): void {
    const baseType = baseTypeOverride
      ? normalizeTypeText(baseTypeOverride)
      : normalizeTypeText(this.sliceTokens(tokens, start, candidate.nameIndex));
    const params = this.parseParameters(
      tokens,
      candidate.openParen + 1,
      candidate.closeParen,
    );
    const signatureEnd = definition ? candidate.closeParen + 1 : terminator;
    this.decls.push({
      name: candidate.name,
      kind: definition ? 'function' : 'prototype',
      fileUri: this.uri,
      line: tokens[candidate.nameIndex].line,
      nameStart: tokens[candidate.nameIndex].char,
      nameEnd: tokens[candidate.nameIndex].endChar,
      endLine: definition && closeBrace >= 0 ? tokens[closeBrace].line : tokens[terminator].line,
      endCharacter: tokens[terminator].endChar,
      typeText: baseType,
      signature: collapseText(`${baseTypeOverride ?? ''} ${this.sliceTokens(tokens, start, signatureEnd)}`),
      storage: extractStorage(tokens, start, candidate.nameIndex),
      isPointer: false,
      pointerLevel: 0,
      isArray: false,
      isConst: false,
      isDefinition: definition,
      params,
      bodyStartLine: definition ? tokens[terminator].line : undefined,
      bodyEndLine: definition && closeBrace >= 0 ? tokens[closeBrace].line : undefined,
    });
  }

  private parseParameters(tokens: Tok[], start: number, end: number): CParam[] {
    const parts = this.splitTopLevel(tokens, start, end, ',');
    const params: CParam[] = [];
    for (const [a, b] of parts) {
      if (a >= b) {
        continue;
      }
      const text = collapseText(this.sliceTokens(tokens, a, b));
      if (!text || text === 'void') {
        continue;
      }
      const declarator = this.parseDeclarator(tokens, a, b);
      params.push({
        name: declarator?.name && !isKeyword(declarator.name) ? declarator.name : '',
        typeText: normalizeTypeText(declarator?.typeText || text),
        isPointer: Boolean(declarator?.isPointer) || text.includes('*'),
      });
    }
    return params;
  }

  private findFunctionCandidate(
    tokens: Tok[],
    start: number,
    terminator: number,
  ): FunctionCandidate | undefined {
    let paren = 0;
    let bracket = 0;
    for (let i = start; i < terminator; i += 1) {
      const text = tokens[i].text;
      if (text === '(') {
        if (paren === 0 && bracket === 0 && i > start) {
          const previous = tokens[i - 1];
          if (
            isIdentifier(previous.text) &&
            !isKeyword(previous.text) &&
            !isTypeTagIdentifier(tokens, i - 1)
          ) {
            const close = this.findMatching(tokens, i);
            if (close > 0 && close < terminator && this.validAfterSignature(tokens, close, terminator)) {
              const before = tokens.slice(start, i - 1);
              if (before.length > 0 && this.hasTypeToken(before)) {
                return {
                  name: previous.text,
                  nameIndex: i - 1,
                  openParen: i,
                  closeParen: close,
                };
              }
            }
          }
        }
        paren += 1;
        continue;
      }
      if (text === ')') {
        paren = Math.max(0, paren - 1);
        continue;
      }
      if (text === '[') {
        bracket += 1;
        continue;
      }
      if (text === ']') {
        bracket = Math.max(0, bracket - 1);
      }
    }
    return undefined;
  }

  private validAfterSignature(tokens: Tok[], close: number, terminator: number): boolean {
    let index = close + 1;
    while (index < terminator) {
      const text = tokens[index].text;
      if (text === '(') {
        const end = this.findMatching(tokens, index);
        if (end < 0) {
          return false;
        }
        index = end + 1;
        continue;
      }
      if (text === '=' || text === ',' || text === ')' || text === ']') {
        return false;
      }
      if (text === ';' || text === '{' || text === '}') {
        return false;
      }
      index += 1;
    }
    return true;
  }

  private hasTypeToken(tokens: Tok[]): boolean {
    return tokens.some((token) => (
      isIdentifier(token.text) || token.text === '*' || token.text === 'const'
    ));
  }

  private parseDeclarator(
    tokens: Tok[],
    start: number,
    end: number,
  ): DeclaratorInfo | undefined {
    if (start >= end) {
      return undefined;
    }
    const signature = collapseText(this.sliceTokens(tokens, start, end));
    const equals = this.findTopLevelToken(tokens, start, end, '=');
    const declEnd = equals ?? end;
    const initText = equals !== undefined
      ? collapseText(this.sliceTokens(tokens, equals + 1, end))
      : undefined;
    // Function pointer declarator: `ret (*name)(params)`
    for (let i = start; i < declEnd - 1; i += 1) {
      if (tokens[i].text !== '(' || tokens[i + 1]?.text !== '*') {
        continue;
      }
      let j = i + 1;
      let stars = 0;
      while (tokens[j]?.text === '*') {
        stars += 1;
        j += 1;
      }
      const nameTok = tokens[j];
      if (!nameTok || !isIdentifier(nameTok.text) || tokens[j + 1]?.text !== ')') {
        continue;
      }
      const typeText = normalizeTypeText(this.sliceTokens(tokens, start, i));
      return {
        name: nameTok.text,
        nameStart: nameTok.char,
        nameEnd: nameTok.endChar,
        line: nameTok.line,
        typeText,
        signature,
        storage: extractStorage(tokens, start, end),
        isPointer: true,
        pointerLevel: Math.max(1, stars),
        isArray: false,
        isConst: this.sliceTokens(tokens, start, declEnd).includes('const'),
        baseTypeText: typeText,
        initText,
        isFunctionPointer: true,
      };
    }
    let paren = 0;
    let bracket = 0;
    let nameIndex = -1;
    for (let i = start; i < declEnd; i += 1) {
      const text = tokens[i].text;
      if (text === '(') {
        paren += 1;
        continue;
      }
      if (text === ')') {
        paren = Math.max(0, paren - 1);
        continue;
      }
      if (text === '[') {
        bracket += 1;
        continue;
      }
      if (text === ']') {
        bracket = Math.max(0, bracket - 1);
        continue;
      }
      if (paren === 0 && bracket === 0 && isIdentifier(text) && !isKeyword(text)) {
        // `struct Tag` / `union Tag` / `enum Tag` token after the keyword is a type name.
        nameIndex = i;
      }
    }
    if (nameIndex < 0) {
      return undefined;
    }
    const nameTok = tokens[nameIndex];
    if (isTypeTagIdentifier(tokens, nameIndex)) {
      return undefined;
    }
    let pointerLevel = 0;
    for (let i = start; i < nameIndex; i += 1) {
      if (tokens[i].text === '*') {
        pointerLevel += 1;
      }
    }
    const typeEnd = nameIndex;
    let typeText = normalizeTypeText(this.sliceTokens(tokens, start, typeEnd));
    // `UINT8 a, *b` – later declarators inherit the base type.
    if (!typeText && pointerLevel > 0) {
      typeText = '';
    }
    const afterName = this.sliceTokens(tokens, nameIndex + 1, declEnd);
    return {
      name: nameTok.text,
      nameStart: nameTok.char,
      nameEnd: nameTok.endChar,
      line: nameTok.line,
      typeText: typeText || '',
      signature,
      storage: extractStorage(tokens, start, end),
      isPointer: pointerLevel > 0,
      pointerLevel,
      isArray: afterName.includes('['),
      isConst: this.sliceTokens(tokens, start, declEnd).includes('const'),
      baseTypeText: typeText || '',
      initText,
      isFunctionPointer: false,
    };
  }

  private findStatementEnd(
    tokens: Tok[],
    start: number,
  ): { kind: 'semi' | 'brace' | 'close'; index: number } {
    let paren = 0;
    let bracket = 0;
    let sawInitializer = false;
    for (let i = start; i < tokens.length; i += 1) {
      const text = tokens[i].text;
      if (text === '(') {
        paren += 1;
        continue;
      }
      if (text === ')') {
        paren = Math.max(0, paren - 1);
        continue;
      }
      if (text === '[') {
        bracket += 1;
        continue;
      }
      if (text === ']') {
        bracket = Math.max(0, bracket - 1);
        continue;
      }
      if (paren !== 0 || bracket !== 0) {
        continue;
      }
      if (text === '=') {
        sawInitializer = true;
        continue;
      }
      if (text === ';') {
        return { kind: 'semi', index: i };
      }
      if (text === '{') {
        if (sawInitializer) {
          const close = this.findMatching(tokens, i);
          if (close < 0) {
            return { kind: 'brace', index: tokens.length - 1 };
          }
          i = close;
          sawInitializer = false;
          continue;
        }
        return { kind: 'brace', index: i };
      }
      if (text === '}') {
        return { kind: 'close', index: i };
      }
    }
    return { kind: 'semi', index: tokens.length - 1 };
  }

  private findSemicolon(tokens: Tok[], start: number): number {
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let i = start; i < tokens.length; i += 1) {
      const text = tokens[i].text;
      if (text === '(') {
        paren += 1;
      } else if (text === ')') {
        paren = Math.max(0, paren - 1);
      } else if (text === '[') {
        bracket += 1;
      } else if (text === ']') {
        bracket = Math.max(0, bracket - 1);
      } else if (text === '{') {
        brace += 1;
      } else if (text === '}') {
        brace = Math.max(0, brace - 1);
      } else if (paren === 0 && bracket === 0 && brace === 0 && text === ';') {
        return i;
      }
    }
    return tokens.length - 1;
  }

  private skipStatement(tokens: Tok[], start: number): number {
    const terminator = this.findStatementEnd(tokens, start);
    if (terminator.kind === 'brace') {
      const close = this.findMatching(tokens, terminator.index);
      return close < 0 ? tokens.length : close + 1;
    }
    return terminator.index + 1;
  }

  private findMatching(tokens: Tok[], openIndex: number): number {
    const open = tokens[openIndex]?.text;
    const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '';
    if (!close) {
      return -1;
    }
    let depth = 0;
    for (let i = openIndex; i < tokens.length; i += 1) {
      if (tokens[i].text === open) {
        depth += 1;
      } else if (tokens[i].text === close) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  private splitTopLevel(
    tokens: Tok[],
    start: number,
    end: number,
    separator: string,
  ): Array<[number, number]> {
    const parts: Array<[number, number]> = [];
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    let partStart = start;
    for (let i = start; i < end; i += 1) {
      const text = tokens[i].text;
      if (text === '(') {
        paren += 1;
      } else if (text === ')') {
        paren = Math.max(0, paren - 1);
      } else if (text === '[') {
        bracket += 1;
      } else if (text === ']') {
        bracket = Math.max(0, bracket - 1);
      } else if (text === '{') {
        brace += 1;
      } else if (text === '}') {
        brace = Math.max(0, brace - 1);
      } else if (paren === 0 && bracket === 0 && brace === 0 && text === separator) {
        parts.push([partStart, i]);
        partStart = i + 1;
      }
    }
    if (partStart < end) {
      parts.push([partStart, end]);
    }
    return parts;
  }

  private findTopLevelToken(
    tokens: Tok[],
    start: number,
    end: number,
    target: string,
  ): number | undefined {
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let i = start; i < end; i += 1) {
      const text = tokens[i].text;
      if (text === '(') {
        paren += 1;
      } else if (text === ')') {
        paren = Math.max(0, paren - 1);
      } else if (text === '[') {
        bracket += 1;
      } else if (text === ']') {
        bracket = Math.max(0, bracket - 1);
      } else if (text === '{') {
        brace += 1;
      } else if (text === '}') {
        brace = Math.max(0, brace - 1);
      } else if (paren === 0 && bracket === 0 && brace === 0 && text === target) {
        return i;
      }
    }
    return undefined;
  }

  private sliceTokens(tokens: Tok[], start: number, end: number): string {
    if (start >= end) {
      return '';
    }
    const first = tokens[start];
    const last = tokens[end - 1];
    return this.text.slice(first.offset, last.endOffset);
  }

  private buildOwners(): COwnerRange[] {
    const owners: COwnerRange[] = [];
    for (const decl of this.decls) {
      if (decl.kind === 'function' && decl.bodyStartLine !== undefined) {
        owners.push({
          name: decl.name,
          kind: 'function',
          startLine: decl.line,
          endLine: decl.bodyEndLine ?? decl.endLine,
        });
      } else if (decl.kind === 'variable' && decl.initText) {
        owners.push({
          name: decl.name,
          kind: 'variable',
          startLine: decl.line,
          endLine: decl.endLine,
        });
      } else if (decl.kind === 'macro' && decl.bodyStartLine !== undefined) {
        owners.push({
          name: decl.name,
          kind: 'macro',
          startLine: decl.bodyStartLine,
          endLine: decl.bodyEndLine ?? decl.endLine,
        });
      }
    }
    return owners;
  }

  private scanUses(): {
    words: CWord[];
    calls: CCallSite[];
    memberAccesses: CMemberAccess[];
  } {
    const words: CWord[] = [];
    const calls: CCallSite[] = [];
    const memberAccesses: CMemberAccess[] = [];
    const wordPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let match: RegExpExecArray | null;
    while ((match = wordPattern.exec(this.masked)) !== null) {
      const name = match[0];
      if (isKeyword(name)) {
        continue;
      }
      const offset = match.index;
      const position = this.map.position(offset);
      const endCharacter = position.character + name.length;
      words.push({
        name,
        line: position.line,
        character: position.character,
        endCharacter,
      });
      const after = this.masked.slice(offset + name.length, offset + name.length + 4);
      if (/^\s*\(/.test(after)) {
        let back = offset - 1;
        while (back >= 0 && (this.masked[back] === ' ' || this.masked[back] === '\t')) {
          back -= 1;
        }
        let operator: '.' | '->' | undefined;
        if (this.masked[back] === '.') {
          operator = '.';
        } else if (this.masked[back] === '>' && this.masked[back - 1] === '-') {
          operator = '->';
        }
        calls.push({
          name,
          line: position.line,
          character: position.character,
          endCharacter,
          operator,
        });
      }
    }

    const accessPatterns: Array<{ pattern: RegExp; operator: '.' | '->' }> = [
      { pattern: /([A-Za-z_$][A-Za-z0-9_$]*)\s*(\.|->)\s*([A-Za-z_$][A-Za-z0-9_$]*)/g, operator: '.' },
    ];
    for (const entry of accessPatterns) {
      let access: RegExpExecArray | null;
      while ((access = entry.pattern.exec(this.masked)) !== null) {
        const owner = access[1];
        const operator = access[2] as '.' | '->';
        const member = access[3];
        const memberOffset = access.index + access[0].lastIndexOf(member);
        const ownerPosition = this.map.position(access.index);
        const memberPosition = this.map.position(memberOffset);
        memberAccesses.push({
          owner,
          member,
          operator,
          line: memberPosition.line,
          character: ownerPosition.character,
          endCharacter: ownerPosition.character + owner.length,
          memberStart: memberPosition.character,
          memberEnd: memberPosition.character + member.length,
          operatorStart: access.index + access[0].indexOf(operator),
        });
      }
    }
    const derefPattern = /\(\s*\*\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let deref: RegExpExecArray | null;
    while ((deref = derefPattern.exec(this.masked)) !== null) {
      const owner = deref[1];
      const member = deref[2];
      const ownerOffset = deref.index + deref[0].indexOf(owner);
      const memberOffset = deref.index + deref[0].lastIndexOf(member);
      const ownerPosition = this.map.position(ownerOffset);
      const memberPosition = this.map.position(memberOffset);
      memberAccesses.push({
        owner,
        member,
        operator: '.',
        line: memberPosition.line,
        character: ownerPosition.character,
        endCharacter: ownerPosition.character + owner.length,
        memberStart: memberPosition.character,
        memberEnd: memberPosition.character + member.length,
        operatorStart: memberOffset - 1,
      });
    }
    // Enrich member-access operator for `p->x` (the generic pattern above
    // only captures the operator but not a stable operator kind).
    const arrowPattern = /([A-Za-z_$][A-Za-z0-9_$]*)\s*->\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let arrow: RegExpExecArray | null;
    while ((arrow = arrowPattern.exec(this.masked)) !== null) {
      const owner = arrow[1];
      const member = arrow[2];
      const ownerOffset = arrow.index;
      const memberOffset = arrow.index + arrow[0].lastIndexOf(member);
      const ownerPosition = this.map.position(ownerOffset);
      const memberPosition = this.map.position(memberOffset);
      const existing = memberAccesses.find((entry) => (
        entry.line === memberPosition.line
        && entry.memberStart === memberPosition.character
        && entry.owner === owner
      ));
      if (existing) {
        existing.operator = '->';
      }
    }
    return { words, calls, memberAccesses: dedupeMemberAccesses(memberAccesses) };
  }
}

interface TypeSpec {
  kind: 'struct' | 'union' | 'enum';
  tag?: string;
  tagToken?: Tok;
  next: number;
  body?: {
    start: number;
    end: number;
    startLine: number;
    endLine: number;
  };
}

interface DeclaratorInfo {
  name: string;
  nameStart: number;
  nameEnd: number;
  line: number;
  typeText: string;
  signature: string;
  storage: string;
  isPointer: boolean;
  pointerLevel: number;
  isArray: boolean;
  isConst: boolean;
  baseTypeText: string;
  initText?: string;
  isFunctionPointer: boolean;
}

interface FunctionCandidate {
  name: string;
  nameIndex: number;
  openParen: number;
  closeParen: number;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function isKeyword(value: string): boolean {
  return C_KEYWORDS.has(value);
}

function isAttributeName(value: string): boolean {
  return value.startsWith('__')
    || /^(?:attribute|declspec|alignas|packed|aligned)$/i.test(value);
}

function isTypeTagIdentifier(tokens: Tok[], index: number): boolean {
  const previous = tokens[index - 1]?.text;
  return previous === 'struct' || previous === 'union' || previous === 'enum';
}

function normalizeTypeText(value: string): string {
  return collapseText(value)
    .replace(/\b(?:extern|static|register|auto|inline|typedef|_Thread_local)\b\s*/g, '')
    .replace(/\s*\*\s*/g, ' *')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractStorage(tokens: Tok[], start: number, end: number): string {
  const storage: string[] = [];
  for (let i = start; i < end; i += 1) {
    const text = tokens[i].text;
    if (STORAGE_KEYWORDS.has(text) && text !== 'typedef') {
      storage.push(text);
    }
  }
  return storage.join(' ');
}

function baseTypeName(typeText: string): string {
  const cleaned = normalizeTypeText(typeText)
    .replace(/\b(?:const|volatile|restrict)\b/g, ' ')
    .replace(/\s*\*+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return '';
  }
  const structMatch = /^(struct|union|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(cleaned);
  if (structMatch) {
    return `${structMatch[1]} ${structMatch[2]}`;
  }
  // Multi-word primitive specifiers (`unsigned char`, `long long`, ...) keep
  // every keyword; user-defined types are a single identifier.
  if (/^(unsigned|signed|short|long|int|char|float|double|void|_Bool)(\s+(unsigned|signed|short|long|int|char|float|double))?$/.test(cleaned)) {
    return cleaned;
  }
  const tokens = cleaned.split(/\s+/).filter((token) => token.length > 0);
  return tokens[tokens.length - 1] ?? '';
}

function dedupeMemberAccesses(entries: CMemberAccess[]): CMemberAccess[] {
  const seen = new Set<string>();
  const result: CMemberAccess[] = [];
  for (const entry of entries) {
    const key = `${entry.line}:${entry.memberStart}:${entry.owner}:${entry.member}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/* --------------------------------------------------------------- assembly */

function parseAssemblyFile(uri: string, path: string, text: string): CFileModel {
  const lines = text.split(/\r?\n/);
  const decls: CDecl[] = [];
  const asmRefs: CAsmRef[] = [];
  const owners: COwnerRange[] = [];
  const words: CWord[] = [];
  const seenLabels = new Set<string>();
  let currentLabel: { name: string; start: number } | undefined;

  const finalizeOwner = (endLine: number): void => {
    if (currentLabel) {
      owners.push({
        name: currentLabel.name,
        kind: 'label',
        startLine: currentLabel.start,
        endLine,
      });
      currentLabel = undefined;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.replace(/;.*$/, '').replace(/\/\/.*$/, '');
    const labelMatch = /^\s*([A-Za-z_.$][A-Za-z0-9_.$]*)\s*:/.exec(line);
    if (labelMatch && !/^\s*[A-Za-z]+\s+\S/.test(line)) {
      const name = labelMatch[1];
      if (!seenLabels.has(name)) {
        seenLabels.add(name);
        decls.push(makeAsmLabel(uri, name, index, line.indexOf(name), true));
      }
      finalizeOwner(index - 1);
      currentLabel = { name, start: index };
    }
    const directive = /^\s*\.(?:global|globl|export|public)\s+([A-Za-z_.$][A-Za-z0-9_.$]*)/.exec(line);
    if (directive) {
      const name = directive[1];
      if (!seenLabels.has(name)) {
        seenLabels.add(name);
        decls.push(makeAsmLabel(uri, name, index, line.indexOf(name), false));
      }
    }
    const instruction = /^\s*([A-Za-z][A-Za-z0-9.]*)\s+([^,;]+)/.exec(line);
    if (instruction) {
      const mnemonic = instruction[1].toLowerCase();
      const operand = instruction[2];
      const targetMatch = /([A-Za-z_.$][A-Za-z0-9_.$]*)/.exec(operand);
      if (targetMatch) {
        const target = targetMatch[1];
        const character = line.indexOf(target, line.indexOf(operand));
        const callLike = /^(?:call|callq|bl|blx|bx|jal|jalr|jsr|rcall|icall)$/.test(mnemonic);
        const branchLike = /^(?:j|je|jne|jz|jnz|beq|bne|bgt|blt|bge|ble|b|br|cbz|cbnz|tbz|tbnz|bra|jmp|loop)$/.test(mnemonic);
        if (callLike || branchLike) {
          asmRefs.push({
            name: target,
            line: index,
            character: character >= 0 ? character : 0,
            endCharacter: (character >= 0 ? character : 0) + target.length,
            kind: callLike ? 'call' : 'jump',
          });
        }
      }
    }
    const wordPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let word: RegExpExecArray | null;
    while ((word = wordPattern.exec(line)) !== null) {
      if (/^(?:mov|ldr|str|push|pop|lsl|lsr|and|orr|eor|add|sub|cmp|ret|nop|r\d+|sp|lr|pc)$/i.test(word[0])) {
        continue;
      }
      words.push({
        name: word[0],
        line: index,
        character: word.index,
        endCharacter: word.index + word[0].length,
      });
    }
  }
  finalizeOwner(lines.length - 1);
  return {
    uri,
    path,
    text,
    lines,
    isHeader: false,
    isAssembly: true,
    decls,
    includes: [],
    words,
    calls: asmRefs
      .filter((entry) => entry.kind === 'call')
      .map((entry) => ({
        name: entry.name,
        line: entry.line,
        character: entry.character,
        endCharacter: entry.endCharacter,
      })),
    memberAccesses: [],
    asmRefs,
    owners,
    directiveLines: [],
  };
}

function makeAsmLabel(
  uri: string,
  name: string,
  line: number,
  character: number,
  definition: boolean,
): CDecl {
  return {
    name,
    kind: 'label',
    fileUri: uri,
    line,
    nameStart: Math.max(0, character),
    nameEnd: Math.max(0, character) + name.length,
    endLine: line,
    endCharacter: Math.max(0, character) + name.length,
    typeText: 'label',
    signature: definition ? `${name}:` : `.global ${name}`,
    storage: '',
    isPointer: false,
    pointerLevel: 0,
    isArray: false,
    isConst: false,
    isDefinition: definition,
  };
}
