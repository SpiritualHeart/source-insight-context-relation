import type { SourceLocation } from './protocol';

/** Pure helpers kept free of the `vscode` module so they can be unit tested. */

const HEADER_EXTENSION = /\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tpp)$/i;
const C_LIKE_LANGUAGES = new Set([
  'c',
  'cpp',
  'cuda-cpp',
  'objective-c',
  'objective-cpp',
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
  'java',
  'csharp',
  'go',
  'rust',
]);

export interface DefinitionCandidate {
  location: SourceLocation;
  origin: 'definition' | 'declaration' | 'workspace' | 'fallback';
}

export interface DefinitionChoiceOptions {
  languageId: string;
  currentUri?: string;
  preferHeaderForVariables?: boolean;
}

export interface ReferenceClassificationInput {
  name: string;
  lineText: string;
  isHeader: boolean;
  isFunction: boolean;
}

export type ReferenceClassification =
  | 'declaration'
  | 'call'
  | 'read'
  | 'write'
  | 'reference';

export interface ContextRangeInput {
  totalLines: number;
  targetStartLine: number;
  targetEndLine: number;
  symbolStartLine?: number;
  symbolEndLine?: number;
  contextLines: number;
  maxLines: number;
}

export interface ContextRange {
  startLine: number;
  endLine: number;
  truncatedTop: boolean;
  truncatedBottom: boolean;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getPathFromUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    return decodeURIComponent(parsed.pathname).replace(/\//g, '\\');
  } catch {
    return uri;
  }
}

export function fileNameFromUri(uri: string): string {
  const path = getPathFromUri(uri).replace(/[\\/]+$/, '');
  const name = path.split(/[\\/]/).pop();
  return name && name.length > 0 ? name : uri;
}

export function isHeaderFile(uriOrPath: string): boolean {
  const path = getPathFromUri(uriOrPath).split('?')[0].split('#')[0];
  return HEADER_EXTENSION.test(path);
}

export function isStubFile(uriOrPath: string): boolean {
  const path = getPathFromUri(uriOrPath).split('?')[0].split('#')[0].toLowerCase();
  return path.endsWith('.pyi') || path.endsWith('.d.ts');
}

export function isCLikeLanguage(languageId: string): boolean {
  return C_LIKE_LANGUAGES.has(languageId);
}

/**
 * Reference providers occasionally return the same file URI with a different
 * drive-letter/percent-encoding spelling (for example `file:///D:/...` versus
 * `file:///d%3A/...`). Normalize for identity checks so definitions do not
 * appear as their own reference.
 */
export function normalizeUriForComparison(uri: string): string {
  try {
    const parsed = new URL(uri);
    let path = decodeURIComponent(parsed.pathname).replace(/\\/g, '/');
    let host = parsed.host;
    if (process.platform === 'win32') {
      path = path.toLowerCase();
      host = host.toLowerCase();
    }
    return `${parsed.protocol}//${host}${path}`;
  } catch {
    return uri;
  }
}

export function locationKey(location: SourceLocation): string {
  return [
    normalizeUriForComparison(location.uri),
    location.startLine,
    location.startCharacter,
    location.endLine,
    location.endCharacter,
  ].join(':');
}

export function locationsEqual(a: SourceLocation, b: SourceLocation): boolean {
  return locationKey(a) === locationKey(b);
}

export function dedupeLocations<T extends { location: SourceLocation }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = locationKey(item.location);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function compareLocations(a: SourceLocation, b: SourceLocation): number {
  if (a.uri !== b.uri) {
    return a.uri.localeCompare(b.uri);
  }
  if (a.startLine !== b.startLine) {
    return a.startLine - b.startLine;
  }
  return a.startCharacter - b.startCharacter;
}

export function scoreDefinitionCandidate(
  candidate: DefinitionCandidate,
  options: DefinitionChoiceOptions,
): number {
  const header = isHeaderFile(candidate.location.uri);
  let score = 0;

  if (candidate.origin === 'definition') {
    score += 55;
  } else if (candidate.origin === 'declaration') {
    score += 15;
  } else if (candidate.origin === 'fallback') {
    score -= 80;
  }

  if (options.currentUri && candidate.location.uri === options.currentUri) {
    score += 24;
  }

  if (isCLikeLanguage(options.languageId)) {
    if (options.preferHeaderForVariables) {
      if (header) {
        score += 40;
      }
    } else if (!header) {
      score += 75;
    } else {
      score -= 10;
    }
  }

  if (isStubFile(candidate.location.uri)) {
    score -= 35;
  }

  if (candidate.location.uri.startsWith('untitled:')) {
    score -= 20;
  }

  return score;
}

export function chooseBestDefinition(
  candidates: DefinitionCandidate[],
  options: DefinitionChoiceOptions,
): DefinitionCandidate | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  let best = candidates[0];
  let bestScore = scoreDefinitionCandidate(best, options);
  for (const candidate of candidates.slice(1)) {
    const score = scoreDefinitionCandidate(candidate, options);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function stripLineComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < text.length - 1; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && char === '/' && text[i + 1] === '/') {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * Heuristic C/C++ style prototype detector. It intentionally errs on the side of
 * classifying something as a call, and is used only as a fallback when no
 * language server declaration is available.
 */
export function looksLikeFunctionDeclaration(lineText: string, name: string): boolean {
  const line = stripLineComment(lineText);
  const escaped = escapeRegExp(name);
  const finder = new RegExp(`\\b${escaped}\\b\\s*\\(`, 'g');
  let match: RegExpExecArray | null;

  while ((match = finder.exec(line)) !== null) {
    const nameStart = match.index;
    const openParen = line.indexOf('(', nameStart + name.length);
    if (openParen < 0) {
      continue;
    }

    let depth = 0;
    let closeParen = -1;
    let inSingle = false;
    let inDouble = false;
    let escapedChar = false;
    for (let i = openParen; i < line.length; i += 1) {
      const char = line[i];
      if (escapedChar) {
        escapedChar = false;
        continue;
      }
      if (char === '\\') {
        escapedChar = true;
        continue;
      }
      if (char === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (char === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (inSingle || inDouble) {
        continue;
      }
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      }
    }

    if (closeParen < 0) {
      continue;
    }

    const after = line.slice(closeParen + 1);
    const firstBrace = after.indexOf('{');
    const firstSemicolon = after.indexOf(';');
    if (firstSemicolon < 0 || (firstBrace >= 0 && firstBrace < firstSemicolon)) {
      continue;
    }

    const before = line.slice(0, nameStart).trim();
    if (before.length === 0) {
      continue;
    }
    let openParens = 0;
    for (const char of before) {
      if (char === '(') {
        openParens += 1;
      } else if (char === ')') {
        openParens -= 1;
      }
    }
    if (openParens > 0) {
      // The name is inside an expression such as `if (a > foo())`.
      continue;
    }
    if (/(?:^|\s)(?:return|co_return|co_await|throw|new|delete|sizeof|case|if|while|for|switch|else|do)\s*$/.test(before)) {
      continue;
    }
    if (/[=,?:(.;\[\])]\s*$/.test(before)) {
      continue;
    }
    if (/->\s*$/.test(before)) {
      continue;
    }
    if (/(?:^|[^\w])(?:return|co_return|co_await|throw|new|delete)\s+[^()]*$/.test(before)) {
      continue;
    }
    if (!/[A-Za-z_~]/.test(before)) {
      continue;
    }

    return true;
  }

  return false;
}

export function looksLikeCall(lineText: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  return new RegExp(`\\b${escaped}\\b\\s*\\(`).test(lineText);
}

export function looksLikeWrite(lineText: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  const patterns = [
    new RegExp(`\\b${escaped}\\b\\s*(?:\\+\\+|--|[+\\-*/%&|^]?=(?!=))`),
    new RegExp(`(?:\\+\\+|--)\\s*\\b${escaped}\\b`),
    new RegExp(`\\b${escaped}\\b\\s*\\[[^\\]]*\\]\\s*=(?!=)`),
    new RegExp(`\\b${escaped}\\b(?:\\s*(?:\\.|->)\\s*\\w+)+\\s*=(?!=)`),
    new RegExp(
      `\\b(?:memset|memcpy|memmove|strcpy|strncpy|sprintf|snprintf|scanf|fscanf|sscanf)\\s*\\(\\s*\\(?\\s*(?:void\\s*\\*\\s*)?&?\\s*${escaped}\\b`,
    ),
  ];
  return patterns.some((pattern) => pattern.test(lineText));
}

export function classifyReference(
  input: ReferenceClassificationInput,
): ReferenceClassification {
  const { name, lineText, isFunction } = input;

  if (isFunction) {
    if (looksLikeFunctionDeclaration(lineText, name)) {
      return 'declaration';
    }
    if (looksLikeCall(lineText, name)) {
      return 'call';
    }
    return 'reference';
  }

  if (
    input.isHeader &&
    /\bextern\b/.test(lineText) &&
    new RegExp(`\\bextern\\b[^;]*\\b${escapeRegExp(name)}\\b`).test(lineText)
  ) {
    return 'declaration';
  }

  return looksLikeWrite(lineText, name) ? 'write' : 'read';
}

export function computeContextRange(input: ContextRangeInput): ContextRange {
  const totalLines = Math.max(0, input.totalLines);
  const maxLines = Math.max(2, input.maxLines);
  const contextLines = Math.max(0, input.contextLines);
  const targetStart = Math.max(0, Math.min(input.targetStartLine, Math.max(0, totalLines - 1)));
  const targetEnd = Math.max(
    targetStart,
    Math.min(input.targetEndLine, Math.max(0, totalLines - 1)),
  );

  let start: number;
  let end: number;
  let wantedStart: number;
  let wantedEnd: number;

  const hasSymbolRange =
    input.symbolStartLine !== undefined &&
    input.symbolEndLine !== undefined &&
    input.symbolEndLine >= input.symbolStartLine;

  if (hasSymbolRange) {
    wantedStart = Math.max(0, (input.symbolStartLine as number) - 1);
    wantedEnd = Math.min(totalLines - 1, (input.symbolEndLine as number) + 2);
  } else {
    wantedStart = Math.max(0, targetStart - contextLines);
    wantedEnd = Math.min(totalLines - 1, targetEnd + contextLines);
  }

  start = wantedStart;
  end = wantedEnd;

  if (end - start + 1 > maxLines) {
    start = Math.max(0, targetStart - 2);
    end = Math.min(totalLines - 1, start + maxLines - 1);
    if (targetEnd > end) {
      end = Math.min(totalLines - 1, targetEnd + 1);
      start = Math.max(0, end - maxLines + 1);
    }
  }

  return {
    startLine: start,
    endLine: end,
    truncatedTop: start > wantedStart,
    truncatedBottom: end < wantedEnd,
  };
}

export function makeLineExcerpt(text: string, maxLength = 150): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function truncateLabel(value: string, maxLength = 46): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function normalizeDisplayPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
