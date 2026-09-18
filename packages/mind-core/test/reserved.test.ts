import { describe, expect, it } from 'vitest';
import { normalize } from '../src/normalizer.ts';
import { isReserved, RESERVED_BY_NORMALIZED, RESERVED_WORDS } from '../src/reserved.ts';

describe('予約語', () => {
  it('送り仮名の違いを吸収して引ける', () => {
    // 表記ゆれはすべて同じ正規形になる
    for (const raw of ['入れる', '入れ', '入れた']) {
      expect(isReserved(normalize(raw))).toBe(true);
    }
    for (const raw of ['一つ増加し', '一つ増加する']) {
      expect(isReserved(normalize(raw))).toBe(true);
    }
  });

  it('代表表記から引いた結果が表と一致する', () => {
    expect(RESERVED_BY_NORMALIZED.get(normalize('クリア'))).toMatchObject({
      name: 'クリア',
      kind: '予約語',
    });
    expect(RESERVED_BY_NORMALIZED.get(normalize('ファイル情報'))?.kind).toBe('型名');
    expect(RESERVED_BY_NORMALIZED.get(normalize('条件コンパイル'))?.kind).toBe('コンパイラ指示');
  });

  it('配列の `要素数` を引ける（マニュアル 5 配列）', () => {
    for (const raw of ['要素数', '要素数を']) {
      expect(isReserved(normalize(raw)), raw).toBe(true);
    }
    expect(RESERVED_BY_NORMALIZED.get(normalize('要素数'))?.kind).toBe('予約語');
  });

  it('正規形が衝突していない', () => {
    expect(RESERVED_BY_NORMALIZED.size).toBe(RESERVED_WORDS.length);
  });

  it('すべての項目に説明と出典がある', () => {
    for (const w of RESERVED_WORDS) {
      expect(w.doc.length, w.name).toBeGreaterThan(0);
      expect(w.source.length, w.name).toBeGreaterThan(0);
    }
  });

  it('辞書に載る単語は入れない（カーネル単語と重複させない）', () => {
    // `複写` `捨て` などはカーネル単語表から辞書に入る。予約語表の役目ではない
    for (const name of ['複写', '捨て', '表示', '改行']) {
      expect(isReserved(normalize(name)), name).toBe(false);
    }
  });
});
