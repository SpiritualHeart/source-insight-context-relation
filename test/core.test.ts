import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  chooseBestDefinition,
  classifyReference,
  computeContextRange,
  dedupeLocations,
  fileNameFromUri,
  isHeaderFile,
  locationKey,
  looksLikeFunctionDeclaration,
  makeLineExcerpt,
  normalizeDisplayPath,
} from '../src/core';

import type { SourceLocation } from '../src/protocol';

function location(
  uri: string,
  line: number,
  character = 4,
  endCharacter = 12,
): SourceLocation {
  return {
    uri,
    startLine: line,
    startCharacter: character,
    endLine: line,
    endCharacter,
  };
}

test('chooseBestDefinition prefers a C source definition over a header declaration', () => {
  const header = location('file:///repo/include/foo.h', 12);
  const source = location('file:///repo/src/foo.c', 40);
  const chosen = chooseBestDefinition(
    [
      { location: header, origin: 'definition' },
      { location: source, origin: 'declaration' },
    ],
    { languageId: 'c', currentUri: 'file:///repo/include/foo.h' },
  );
  assert.equal(chosen?.location.uri, source.uri);
});

test('chooseBestDefinition does not rewrite same-file inline definitions', () => {
  const inline = location('file:///repo/include/foo.h', 2);
  const chosen = chooseBestDefinition(
    [{ location: inline, origin: 'definition' }],
    { languageId: 'cpp', currentUri: 'file:///repo/include/foo.h' },
  );
  assert.equal(chosen?.location.uri, inline.uri);
});

test('dedupeLocations removes identical locations only', () => {
  const a = location('file:///a.c', 1);
  const b = location('file:///a.c', 1);
  const c = location('file:///a.c', 2);
  assert.equal(dedupeLocations([{ location: a }, { location: b }, { location: c }]).length, 2);
});

test('prototype lines are classified as declarations', () => {
  const samples = [
    'void APP_Model_Set29COutputs(void);',
    'static UINT8 calculate(UINT8 a, UINT8 b);',
    'MY_EXPORT int do_work(void) __attribute__((warn_unused_result));',
    'void callback(void (*handler)(int));',
    'virtual void on_event() const;',
    'std::vector<int> collect_values(void);',
  ];
  for (const line of samples) {
    assert.equal(looksLikeFunctionDeclaration(line, extractName(line)), true, line);
    assert.equal(
      classifyReference({
        name: extractName(line),
        lineText: line,
        isHeader: true,
        isFunction: true,
      }),
      'declaration',
      line,
    );
  }
});

test('call expressions are not mistaken for declarations', () => {
  const samples = [
    'APP_Model_Set29COutputs();',
    'ret = APP_Model_Set29COutputs();',
    'return APP_Model_Set29COutputs();',
    'if (APP_Model_Set29COutputs()) {',
    'p->APP_Model_Set29COutputs();',
    'obj.APP_Model_Set29COutputs();',
    'other(APP_Model_Set29COutputs());',
    'value = (int)APP_Model_Set29COutputs();',
  ];
  for (const line of samples) {
    assert.equal(looksLikeFunctionDeclaration(line, 'APP_Model_Set29COutputs'), false, line);
    assert.equal(
      classifyReference({
        name: 'APP_Model_Set29COutputs',
        lineText: line,
        isHeader: false,
        isFunction: true,
      }),
      'call',
      line,
    );
  }
});

test('member calls and comparisons are not classified as prototypes', () => {
  assert.equal(
    looksLikeFunctionDeclaration('p->APP_Model_Set29COutputs();', 'APP_Model_Set29COutputs'),
    false,
  );
  assert.equal(
    looksLikeFunctionDeclaration('if (a > APP_Model_Set29COutputs());', 'APP_Model_Set29COutputs'),
    false,
  );
});

test('function definitions are not classified as prototypes', () => {
  assert.equal(
    looksLikeFunctionDeclaration('void APP_Model_Set29COutputs(void) {', 'APP_Model_Set29COutputs'),
    false,
  );
  assert.equal(
    looksLikeFunctionDeclaration(
      'INT32 APP_Model_Set29COutputs(UINT8 value) // body next line',
      'APP_Model_Set29COutputs',
    ),
    false,
  );
});

test('extern variable declarations are separated from reads', () => {
  assert.equal(
    classifyReference({
      name: 'g_app_model_state',
      lineText: 'extern UINT8 g_app_model_state;',
      isHeader: true,
      isFunction: false,
    }),
    'declaration',
  );
  assert.equal(
    classifyReference({
      name: 'g_app_model_state',
      lineText: 'g_app_model_state = 1u;',
      isHeader: false,
      isFunction: false,
    }),
    'write',
  );
});

test('variable references distinguish reads and writes', () => {
  assert.equal(
    classifyReference({
      name: 'u8_temp',
      lineText: 'u8_temp = 0;',
      isHeader: false,
      isFunction: false,
    }),
    'write',
  );
  assert.equal(
    classifyReference({
      name: 'u8_temp',
      lineText: 'u8_temp += 1;',
      isHeader: false,
      isFunction: false,
    }),
    'write',
  );
  assert.equal(
    classifyReference({
      name: 'u8_temp',
      lineText: '++u8_temp;',
      isHeader: false,
      isFunction: false,
    }),
    'write',
  );
  assert.equal(
    classifyReference({
      name: 'u8_temp',
      lineText: 'if (u8_temp == 0) {',
      isHeader: false,
      isFunction: false,
    }),
    'read',
  );
  assert.equal(
    classifyReference({
      name: 'u8_temp',
      lineText: 'LOG("%d", u8_temp);',
      isHeader: false,
      isFunction: false,
    }),
    'read',
  );
});

test('context range keeps a long function beginning and reports truncation', () => {
  const range = computeContextRange({
    totalLines: 1000,
    targetStartLine: 200,
    targetEndLine: 200,
    symbolStartLine: 200,
    symbolEndLine: 700,
    contextLines: 12,
    maxLines: 80,
  });
  assert.equal(range.startLine, 198);
  assert.equal(range.endLine - range.startLine + 1, 80);
  assert.equal(range.truncatedBottom, true);
  assert.equal(range.truncatedTop, false);
});

test('context range centers a variable definition when space permits', () => {
  const range = computeContextRange({
    totalLines: 500,
    targetStartLine: 200,
    targetEndLine: 200,
    contextLines: 8,
    maxLines: 100,
  });
  assert.equal(range.startLine, 192);
  assert.equal(range.endLine, 208);
  assert.equal(range.truncatedBottom, false);
});

test('context range clamps to document edges', () => {
  const start = computeContextRange({
    totalLines: 20,
    targetStartLine: 1,
    targetEndLine: 1,
    contextLines: 10,
    maxLines: 100,
  });
  assert.equal(start.startLine, 0);
  assert.equal(start.endLine, 11);

  const end = computeContextRange({
    totalLines: 20,
    targetStartLine: 18,
    targetEndLine: 18,
    contextLines: 10,
    maxLines: 100,
  });
  assert.equal(end.endLine, 19);
  assert.equal(end.startLine, 8);
});

test('path helpers handle Windows file URIs', () => {
  assert.equal(
    fileNameFromUri('file:///d:/Desktop/demo/APP_Model.c'),
    'APP_Model.c',
  );
  assert.equal(isHeaderFile('file:///d:/repo/APP_Model.h'), true);
  assert.equal(isHeaderFile('file:///d:/repo/APP_Model.h.in'), false);
  assert.equal(normalizeDisplayPath('src\\module\\file.c'), 'src/module/file.c');
});

test('location identity normalizes equivalent file URI spellings', () => {
  if (process.platform !== 'win32') {
    return;
  }
  const lower = location('file:///d%3A/repo/APP_Model.c', 4, 5, 28);
  const upper = location('file:///D:/repo/APP_Model.c', 4, 5, 28);
  assert.equal(locationKey(lower), locationKey(upper));
});

test('line excerpt collapses whitespace and truncates', () => {
  assert.equal(makeLineExcerpt('  void   foo( void );  '), 'void foo( void );');
  assert.equal(makeLineExcerpt('abcdefghij', 5), 'abcd…');
});

test('every id requested by the webview is present in the rendered HTML', () => {
  const root = process.cwd();
  const script = fs.readFileSync(path.join(root, 'media', 'webview.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'src', 'webview.ts'), 'utf8');
  const scriptIds = new Set(
    [...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]),
  );
  const htmlIds = new Set(
    [...htmlSource.matchAll(/id="([^"]+)"/g)].map((match) => match[1]),
  );
  const missing = [...scriptIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `Missing webview element ids: ${missing.join(', ')}`);
});

function extractName(line: string): string {
  const match = /([A-Za-z_]\w*)\s*\(/.exec(line);
  assert.ok(match, `Expected an identifier in ${line}`);
  return match[1];
}
