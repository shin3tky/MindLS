/**
 * ホバー表示。
 *
 * 出すのは 種別 / スタック仕様 / 定義位置の抜粋 の 3 つ。
 * スタック仕様コメント（`（単価、個数 → ・）`）は Mind の慣習で定義行に書かれており、
 * 引数と戻りを知る唯一の手がかりなので最優先で見せる。
 */

import { enclosingDefinition, wordAt } from './queries.ts';
import type { ParseResult } from './parser.ts';
import type { StdlibIndex } from './stdlib.ts';
import type { SymbolEntry, SymbolTable } from './symbols.ts';
import type { Position, Range } from './types.ts';

export interface HoverInfo {
  /** Markdown */
  readonly contents: string;
  readonly range: Range;
}

export interface HoverContext {
  readonly parsed: ParseResult;
  readonly symbols: SymbolTable;
  readonly stdlib?: StdlibIndex;
  /** ソースの行。定義の抜粋に使う */
  readonly lines: readonly string[];
  readonly position: Position;
}

function heading(name: string, kind: string, attrs: readonly string[]): string {
  const suffix = attrs.length === 0 ? '' : ' `' + attrs.join(' ') + '`';
  return '**' + name + '**　*' + kind + '*' + suffix;
}

export function hoverAt(ctx: HoverContext): HoverInfo | null {
  const token = wordAt(ctx.parsed, ctx.position);
  if (token === null || token.normalized.length === 0) return null;

  const owner = enclosingDefinition(ctx.parsed, ctx.position);
  const local =
    owner === null
      ? undefined
      : ctx.symbols.locals.get(owner.name.normalized)?.get(token.normalized);
  const entry = local ?? ctx.symbols.globals.get(token.normalized);

  if (entry !== undefined) return { contents: renderSymbol(entry, ctx), range: token.range };

  const std = ctx.stdlib?.byNormalized.get(token.normalized);
  if (std === undefined) return null;

  const out = [heading(std.name, std.kind, std.attrs)];
  if (std.stack !== null) out.push('', '```', std.stack, '```');
  const origin = ctx.stdlib?.origin ? `（${ctx.stdlib.origin}）` : '';
  out.push(
    '',
    '標準ライブラリ ' + (ctx.stdlib?.library ?? '') + origin + ' — `' + std.file + ':' + String(std.line) + '`',
  );
  return { contents: out.join('\n'), range: token.range };
}

function renderSymbol(entry: SymbolEntry, ctx: HoverContext): string {
  const out: string[] = [heading(entry.aliases[0] ?? entry.normalized, entry.kind, [])];

  if (entry.stackSpec !== null) out.push('', '```', entry.stackSpec, '```');
  if (entry.equivalentTo !== null) out.push('', '`' + entry.equivalentTo + '` と等価');
  if (entry.aliases.length > 1) {
    out.push('', '表記ゆれ: ' + entry.aliases.map((a) => '`' + a + '`').join(' / '));
  }

  const first = entry.locations[0];
  if (first !== undefined) {
    const text = ctx.lines[first.start.line];
    if (text !== undefined) out.push('', '```mind', text.trimEnd(), '```');
    const where = entry.owner === null ? '' : '（`' + entry.owner + '` の局所）';
    out.push('', String(first.start.line + 1) + ' 行目で定義' + where);
  }
  if (entry.locations.length > 1) {
    const all = entry.locations.map((l) => String(l.start.line + 1) + ' 行目').join(' / ');
    out.push('', '定義位置: ' + all);
  }
  return out.join('\n');
}
