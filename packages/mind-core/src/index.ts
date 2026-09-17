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
  IncludeRef,
  ParseDiagnostic,
  ParseDiagnosticCode,
  ParseResult,
  Visibility,
  WordRef,
} from './parser.ts';
export { buildSymbolTable, resolve, visibleSymbols } from './symbols.ts';
export type { SymbolEntry, SymbolTable } from './symbols.ts';
export {
  ATTRIBUTE_WORDS,
  BLOCK_SPECS,
  blockRoleOf,
  DECLARATION_KEYWORDS,
  DEFINITION_KEYWORDS,
  TEMPLATE_KIND,
  TEMPLATE_MEMBER_KIND,
} from './keywords.ts';
export { analyze } from './diagnostics.ts';
export type {
  AnalysisDiagnostic,
  AnalysisDiagnosticCode,
  AnalyzeOptions,
} from './diagnostics.ts';
export { isReserved, RESERVED_BY_NORMALIZED, RESERVED_WORDS } from './reserved.ts';
export { prepareRename, renameEdits, splitOkurigana, validateName } from './rename.ts';
export type { RenameEdit, RenameError, RenameOptions, RenameTarget } from './rename.ts';
export {
  encodeSemanticTokens,
  semanticTokens,
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
} from './semantic.ts';
export type {
  SemanticContext,
  SemanticToken,
  SemanticTokenModifier,
  SemanticTokenType,
} from './semantic.ts';
export type { ReservedKind, ReservedWord } from './reserved.ts';
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
export { completionsAt, currentWordPrefix, SNIPPETS } from './completion.ts';
export type { CompletionContext, CompletionItem, CompletionSource } from './completion.ts';
export { hoverAt } from './hover.ts';
export type { HoverContext, HoverInfo } from './hover.ts';
export { createStdlibIndex, EMPTY_STDLIB } from './stdlib.ts';
export type { StdlibDocument, StdlibIndex, StdlibWord } from './stdlib.ts';
