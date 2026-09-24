import { extensionOf } from '../languages.js';
import { extractGoImports } from './go.js';
import { extractJavaImports } from './java.js';
import { extractPythonImports } from './python.js';
import { extractRubyImports } from './ruby.js';
import { extractRustImports } from './rust.js';
import { extractTypeScriptImports } from './typescript.js';
import type { Extractor } from './types.js';

const EXTRACTOR_BY_EXTENSION: Readonly<Record<string, Extractor>> = {
  ts: extractTypeScriptImports,
  tsx: extractTypeScriptImports,
  js: extractTypeScriptImports,
  jsx: extractTypeScriptImports,
  mjs: extractTypeScriptImports,
  cjs: extractTypeScriptImports,
  py: extractPythonImports,
  go: extractGoImports,
  rs: extractRustImports,
  java: extractJavaImports,
  rb: extractRubyImports,
};

export function extractorFor(path: string): Extractor | undefined {
  return EXTRACTOR_BY_EXTENSION[extensionOf(path)];
}

export * from './go.js';
export * from './types.js';
