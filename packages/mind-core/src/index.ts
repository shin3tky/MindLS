export {
  SEPARATORS,
  PARTICLES,
  isSeparator,
  isHiragana,
  foldWidthAndCase,
  analyzeWord,
  normalize,
  splitParticle,
  isNegativeForm,
} from './normalizer.ts';
export type { WordAnalysis, ParticleSplit } from './normalizer.ts';
export { lex, isNumberLiteral } from './lexer.ts';
export type { LexResult, LexDiagnostic, LexDiagnosticCode } from './lexer.ts';
export type { Position, Range, Token, TokenKind } from './types.ts';
export { parse } from './parser.ts';
export type {
  Declaration,
  Definition,
  ParseDiagnostic,
  ParseDiagnosticCode,
  ParseResult,
  Visibility,
  WordRef,
} from './parser.ts';
export { buildSymbolTable, resolve, visibleSymbols } from './symbols.ts';
export type { SymbolEntry, SymbolTable } from './symbols.ts';
export { BLOCK_SPECS, blockRoleOf, DECLARATION_KEYWORDS, DEFINITION_KEYWORDS } from './keywords.ts';
export {
  comparePosition,
  containsPosition,
  documentSymbols,
  enclosingDefinition,
  findDefinition,
  findReferences,
  searchSymbols,
  wordAt,
} from './queries.ts';
export type {
  DefinitionResult,
  DocumentSymbolNode,
  ReferenceOptions,
  SymbolMatch,
} from './queries.ts';
