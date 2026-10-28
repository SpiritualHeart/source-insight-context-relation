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

import {
  buildSearchRegExp,
  classifyVariableUse,
  parseSourceFile,
} from '../src/cParser';

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

test('C parser indexes macros, typedefs, struct members, prototypes and definitions', () => {
  const root = process.cwd();
  const headerPath = path.join(root, 'test', 'cpp-demo', 'APP_Model.h');
  const sourcePath = path.join(root, 'test', 'cpp-demo', 'APP_Model.c');
  const header = parseSourceFile(
    'file:///demo/APP_Model.h',
    headerPath,
    fs.readFileSync(headerPath, 'utf8'),
  );
  const source = parseSourceFile(
    'file:///demo/APP_Model.c',
    sourcePath,
    fs.readFileSync(sourcePath, 'utf8'),
  );

  const macroNames = header.decls.filter((decl) => decl.kind === 'macro').map((decl) => decl.name);
  assert.ok(macroNames.includes('FALSE'));
  assert.ok(macroNames.includes('TRUE'));

  const typedefNames = header.decls.filter((decl) => decl.kind === 'typedef').map((decl) => decl.name);
  assert.ok(typedefNames.includes('UINT8'));
  assert.ok(typedefNames.includes('BOOL'));

  const state = header.decls.find((decl) => decl.name === 'APP_ModelState_t' && decl.kind === 'struct');
  assert.ok(state);
  assert.deepEqual(state.members?.map((member) => member.name), ['state', 'enabled']);
  assert.equal(state.isAnonymous, true);

  const prototypes = header.decls.filter((decl) => decl.kind === 'prototype').map((decl) => decl.name);
  assert.ok(prototypes.includes('APP_Model_Set29COutputs'));
  assert.ok(!prototypes.includes('APP_Model_ReadOutput'));

  const definition = source.decls.find((decl) => (
    decl.name === 'APP_Model_Set29COutputs' && decl.kind === 'function'
  ));
  assert.ok(definition);
  assert.equal(definition.isDefinition, true);

  const global = source.decls.find((decl) => decl.name === 'g_app_model');
  assert.ok(global);
  assert.equal(global.kind, 'variable');
  assert.equal(global.isDefinition, true);

  const externState = header.decls.find((decl) => decl.name === 'g_app_model_state');
  assert.ok(externState);
  assert.equal(externState.isDefinition, false);
  assert.match(externState.storage, /extern/);

  const callNames = source.calls.map((call) => call.name);
  assert.ok(callNames.includes('APP_Model_ReadOutput'));
  assert.ok(callNames.includes('APP_Model_WriteOutput'));
});

test('C parser separates struct values from pointers and records member operators', () => {
  const text = [
    'typedef struct {',
    '    UINT8 state;',
    '    UINT8 count;',
    '} ST;',
    'ST g_value;',
    'ST *gp_ptr;',
    'void reset(void)',
    '{',
    '    g_value.state = 1;',
    '    gp_ptr->state = 2;',
    '    g_value = g_value;',
    '    UINT8 *p = &g_value.state;',
    '}',
  ].join('\n');
  const model = parseSourceFile('file:///demo/state.c', 'D:/demo/state.c', text);
  const struct = model.decls.find((decl) => decl.name === 'ST' && decl.kind === 'struct');
  assert.ok(struct);
  assert.deepEqual(struct.members?.map((member) => member.name), ['state', 'count']);

  const value = model.decls.find((decl) => decl.name === 'g_value');
  const pointer = model.decls.find((decl) => decl.name === 'gp_ptr');
  assert.ok(value);
  assert.equal(value.isPointer, false);
  assert.ok(pointer);
  assert.equal(pointer.isPointer, true);
  assert.equal(pointer.baseType, 'ST');

  const valueAccess = model.memberAccesses.find((entry) => entry.owner === 'g_value');
  const pointerAccess = model.memberAccesses.find((entry) => entry.owner === 'gp_ptr');
  assert.ok(valueAccess);
  assert.equal(valueAccess.operator, '.');
  assert.ok(pointerAccess);
  assert.equal(pointerAccess.operator, '->');
  assert.equal(pointerAccess.member, 'state');

  const valueLine = model.lines[8];
  assert.equal(classifyVariableUse(valueLine, valueLine.indexOf('g_value'), valueLine.indexOf('g_value') + 7), 'read');
  const assignLine = model.lines[10];
  const firstValue = assignLine.indexOf('g_value');
  assert.equal(classifyVariableUse(assignLine, firstValue, firstValue + 7), 'write');
  assert.equal(classifyVariableUse(assignLine, assignLine.lastIndexOf('g_value'), assignLine.lastIndexOf('g_value') + 7), 'read');

  const definition = model.decls.find((decl) => decl.name === 'reset');
  assert.ok(definition);
  assert.equal(definition.kind, 'function');
  assert.equal(definition.isDefinition, true);
});

test('pointer typedef aliases keep the pointed-to struct and alias pointer flag', () => {
  const text = [
    'typedef struct {',
    '    UINT8 value;',
    '} *SP;',
    'SP g_sp;',
  ].join('\n');
  const model = parseSourceFile('file:///demo/sp.c', 'D:/demo/sp.c', text);
  const struct = model.decls.find((decl) => decl.kind === 'struct');
  assert.ok(struct);
  assert.ok(struct.name.startsWith('anon@'));
  assert.deepEqual(struct.members?.map((member) => member.name), ['value']);
  const alias = model.decls.find((decl) => decl.name === 'SP' && decl.kind === 'typedef');
  assert.ok(alias);
  assert.equal(alias.isPointer, true);
  const variable = model.decls.find((decl) => decl.name === 'g_sp');
  assert.ok(variable);
  assert.equal(variable.baseType, 'SP');
});

test('struct pointers and struct-returning functions keep the struct type', () => {
  const text = [
    'struct Data {',
    '    UINT8 value;',
    '};',
    'struct Data *g_data;',
    'struct Data get_data(void)',
    '{',
    '    struct Data local;',
    '    return local;',
    '}',
  ].join('\n');
  const model = parseSourceFile('file:///demo/data.c', 'D:/demo/data.c', text);
  const struct = model.decls.find((decl) => decl.name === 'Data' && decl.kind === 'struct');
  assert.ok(struct);
  assert.deepEqual(struct.members?.map((member) => member.name), ['value']);

  const pointer = model.decls.find((decl) => decl.name === 'g_data');
  assert.ok(pointer);
  assert.equal(pointer.isPointer, true);
  assert.equal(pointer.baseType, 'struct Data');

  const getter = model.decls.find((decl) => decl.name === 'get_data');
  assert.ok(getter);
  assert.equal(getter.kind, 'function');
  assert.equal(getter.typeText, 'struct Data');
});

test('assembly parser records labels and call targets', () => {
  const text = [
    '    .global main',
    'main:',
    '    bl helper',
    '    bx lr',
    'helper:',
    '    bx lr',
  ].join('\n');
  const model = parseSourceFile('file:///demo/boot.s', 'D:/demo/boot.s', text);
  const labels = model.decls.filter((decl) => decl.kind === 'label').map((decl) => decl.name);
  assert.ok(labels.includes('main'));
  assert.ok(labels.includes('helper'));
  const calls = model.asmRefs.filter((entry) => entry.kind === 'call').map((entry) => entry.name);
  assert.ok(calls.includes('helper'));
  assert.equal(model.isAssembly, true);
});

test('search patterns support plain text, whole words and regular expressions', () => {
  const plain = buildSearchRegExp('state', { regex: false, caseSensitive: false, wholeWord: false });
  assert.ok(plain.test('g_value.state = 1;'));
  const whole = buildSearchRegExp('state', { regex: false, caseSensitive: false, wholeWord: true });
  assert.equal(whole.test('state_machine'), false);
  assert.equal(whole.test('g_value.state'), true);
  const regex = buildSearchRegExp('APP_\\w+', { regex: true, caseSensitive: true, wholeWord: false });
  assert.ok(regex.test('void APP_Model_Init(void);'));
});

function extractName(line: string): string {
  const match = /([A-Za-z_]\w*)\s*\(/.exec(line);
  assert.ok(match, `Expected an identifier in ${line}`);
  return match[1];
}
