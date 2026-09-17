/**
 * シンボルテーブル。
 *
 * **キーは正規形**。`反応し` と `反応する` は同じ単語なので、同じ項目に束ねる。
 * 生テキストは `aliases` として全部持っておく。リネームや「元の表記で表示」に要る。
 *
 * スコープは 3 段。
 *   ・大域         … ファイル全体（`グローバル。` 配下）
 *   ・局所変数     … 定義の冒頭で宣言され、その定義の中だけで見える
 *   ・局所処理単語 … 親の定義からのみ見える（ネストした定義）
 */

import type { Declaration, Definition, ParseResult, Visibility, WordRef } from './parser.ts';
import type { Range } from './types.ts';

export interface SymbolEntry {
  /** 照合キー */
  readonly normalized: string;
  /** ソース上に現れた表記。最初のものが代表 */
  readonly aliases: readonly string[];
  /** `処理単語` `関数` `変数` `定数` `等価` など */
  readonly kind: string;
  readonly visibility: Visibility;
  /** スタック仕様コメントの中身 */
  readonly stackSpec: string | null;
  /** 定義・宣言が現れた位置（`仮定義` と `本定義` で 2 つになる） */
  readonly locations: readonly Range[];
  /** 等価定義の参照先（正規形） */
  readonly equivalentTo: string | null;
  /** 局所シンボルの場合、それを含む定義の正規形 */
  readonly owner: string | null;
}

export interface SymbolTable {
  /** 大域シンボル（正規形 → 項目） */
  readonly globals: ReadonlyMap<string, SymbolEntry>;
  /** 定義の正規形 → その定義の局所シンボル */
  readonly locals: ReadonlyMap<string, ReadonlyMap<string, SymbolEntry>>;
}

interface MutableEntry {
  normalized: string;
  aliases: string[];
  kind: string;
  visibility: Visibility;
  stackSpec: string | null;
  locations: Range[];
  equivalentTo: string | null;
  owner: string | null;
}

/** `仮定義` / `本定義` は前方参照のための書き分けで、実体はどちらも処理単語 */
function canonicalKind(kind: string): string {
  return kind === '本定義' || kind === '仮定義' ? '処理単語' : kind;
}

function upsert(
  table: Map<string, MutableEntry>,
  ref: WordRef,
  rawKind: string,
  visibility: Visibility,
  options: { stackSpec?: string | null; equivalentTo?: string | null; owner?: string | null } = {},
): void {
  const kind = canonicalKind(rawKind);
  const existing = table.get(ref.normalized);
  if (existing === undefined) {
    table.set(ref.normalized, {
      normalized: ref.normalized,
      aliases: [ref.raw],
      kind,
      visibility,
      stackSpec: options.stackSpec ?? null,
      locations: [ref.range],
      equivalentTo: options.equivalentTo ?? null,
      owner: options.owner ?? null,
    });
    return;
  }

  if (!existing.aliases.includes(ref.raw)) existing.aliases.push(ref.raw);
  existing.locations.push(ref.range);
  if (existing.kind === '不明' && kind !== '不明') existing.kind = kind;
  if (existing.stackSpec === null && (options.stackSpec ?? null) !== null) {
    existing.stackSpec = options.stackSpec ?? null;
  }
  if (existing.equivalentTo === null && (options.equivalentTo ?? null) !== null) {
    existing.equivalentTo = options.equivalentTo ?? null;
  }
}

function freeze(table: Map<string, MutableEntry>): Map<string, SymbolEntry> {
  return new Map([...table].map(([k, v]) => [k, { ...v, aliases: [...v.aliases], locations: [...v.locations] }]));
}

export function buildSymbolTable(result: ParseResult): SymbolTable {
  const globals = new Map<string, MutableEntry>();
  const locals = new Map<string, Map<string, SymbolEntry>>();

  for (const d of result.declarations) {
    addDeclaration(globals, d);
  }

  for (const def of result.definitions) {
    upsert(globals, def.name, def.kind, def.visibility, { stackSpec: def.stackSpec });

    const own = new Map<string, MutableEntry>();
    for (const l of def.locals) {
      upsert(own, l.name, l.kind, 'local', { owner: def.name.normalized });
    }
    // 局所処理単語も同じスコープに置く。親からだけ見える点は局所変数と同じ
    for (const w of def.localWords) {
      upsert(own, w.name, w.kind, 'local', {
        stackSpec: w.stackSpec,
        owner: def.name.normalized,
      });
    }
    if (own.size > 0) {
      // 同じ名前の定義が複数あることがある（`条件コンパイル` で環境ごとに書き分ける）。
      // あとの定義で上書きすると前の定義の局所シンボルが消え、その中の参照が
      // 「定義より前」に見えてしまう。位置は捨てずに足し合わせる。
      const merged = new Map<string, SymbolEntry>(locals.get(def.name.normalized) ?? []);
      for (const [k, v] of freeze(own)) {
        const previous = merged.get(k);
        merged.set(
          k,
          previous === undefined
            ? v
            : {
                ...previous,
                aliases: [...new Set([...previous.aliases, ...v.aliases])],
                locations: [...previous.locations, ...v.locations],
                stackSpec: previous.stackSpec ?? v.stackSpec,
              },
        );
      }
      locals.set(def.name.normalized, merged);
    }
  }

  return { globals: freeze(globals), locals };
}

function addDeclaration(table: Map<string, MutableEntry>, d: Declaration): void {
  upsert(table, d.name, d.kind, d.visibility, {
    equivalentTo: d.equivalentTo?.normalized ?? null,
  });
}

/**
 * 単語を解決する。定義の中にいる場合は局所 → 大域の順に探す。
 */
export function resolve(
  table: SymbolTable,
  normalized: string,
  insideDefinition?: string,
): SymbolEntry | undefined {
  if (insideDefinition !== undefined) {
    const own = table.locals.get(insideDefinition);
    const hit = own?.get(normalized);
    if (hit !== undefined) return hit;
  }
  const entry = table.globals.get(normalized);
  if (entry === undefined) return undefined;
  // 等価定義は参照先まで辿る（循環は 1 回で打ち切る）
  if (entry.equivalentTo !== null) {
    const target = table.globals.get(entry.equivalentTo);
    if (target !== undefined && target.normalized !== entry.normalized) return entry;
  }
  return entry;
}

/** その定義の中から見えるシンボルをすべて集める（補完候補の素） */
export function visibleSymbols(table: SymbolTable, insideDefinition?: string): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  if (insideDefinition !== undefined) {
    const own = table.locals.get(insideDefinition);
    if (own !== undefined) out.push(...own.values());
  }
  out.push(...table.globals.values());
  return out;
}

export type { Definition, Declaration };
