import { describe, expect, it } from 'vitest';
import {
  analyzeWord,
  foldWidthAndCase,
  isNegativeForm,
  isSeparator,
  normalize,
  splitParticle,
} from '../src/normalizer.js';

/**
 * ゴールデンテスト。
 * 出典: Mind プログラミングマニュアル（基礎編）「2 プログラム表記の基本」
 *   https://www.scripts-lab.co.jp/mind/ver9/doc/02-Program-Hyoki.html
 * マニュアルに出てくる等価例をすべてここに写す。ここが崩れると全部崩れる。
 */

describe('送り仮名は無視される', () => {
  it('活用形が同じ語に畳まれる', () => {
    expect(normalize('反応し')).toBe('反応');
    expect(normalize('反応する')).toBe('反応');
    expect(normalize('反応させる')).toBe('反応');
  });

  it('落とした送り仮名は保持される（リネームなどで使う）', () => {
    expect(analyzeWord('反応させる').droppedKana).toBe('させる');
    expect(analyzeWord('反応').droppedKana).toBe('');
  });
});

describe('単語内のひらがなも落ちる', () => {
  it('赤い色で表示する → 赤色表示', () => {
    expect(normalize('赤い色で表示する')).toBe('赤色表示');
  });

  it('区切らなければ 1 単語、区切れば別語', () => {
    // 「赤い色で表示する」と「赤い色で 表示する」は別物であり、類似性は無い
    expect(normalize('赤い色で表示する')).toBe('赤色表示');
    expect(normalize('表示する')).toBe('表示');
    expect(normalize('赤い色で表示する')).not.toBe(normalize('表示する'));
  });
});

describe('先頭のひらがなは保持される', () => {
  it('ご案内する → ご案内', () => {
    expect(normalize('ご案内する')).toBe('ご案内');
  });

  it('ご案内 と 案内 は別語', () => {
    expect(normalize('ご案内する')).not.toBe(normalize('案内する'));
    expect(normalize('案内する')).toBe('案内');
  });
});

describe('ひらがなのみの単語は末尾の助詞だけ落ちる', () => {
  it('つぎに → つぎ', () => {
    expect(normalize('つぎに')).toBe('つぎ');
  });

  it('中間のひらがなは残る', () => {
    expect(normalize('さもなければ')).toBe('さもなけれ');
    expect(analyzeWord('つぎに').allHiragana).toBe(true);
  });

  it('助詞だけの語は削らない', () => {
    expect(normalize('に')).toBe('に');
    expect(normalize('は')).toBe('は');
  });
});

describe('中点は無視される', () => {
  it('トータル・カウント = トータルカウント', () => {
    expect(normalize('トータル・カウント')).toBe(normalize('トータルカウント'));
    expect(normalize('トータル・カウント')).toBe('トータルカウント');
  });

  it('半角中点も同じ', () => {
    expect(normalize('ﾄｰﾀﾙ･ｶｳﾝﾄ')).toBe('トータルカウント');
  });
});

describe('半角カナと全角カナは等価', () => {
  it('濁点・半濁点を合成する', () => {
    expect(foldWidthAndCase('ｶﾞ')).toBe('ガ');   // ｶﾞ
    expect(foldWidthAndCase('ﾊﾟ')).toBe('パ');   // ﾊﾟ
    expect(foldWidthAndCase('ｳﾞ')).toBe('ヴ');   // ｳﾞ
  });

  it('清音はそのまま対応する', () => {
    expect(foldWidthAndCase('ｱｲｳｴｵ')).toBe('アイウエオ');
    expect(normalize('ﾒﾓﾘ')).toBe(normalize('メモリ'));
  });

  it('濁点のつかないカナに濁点が続く場合は合成しない', () => {
    expect(foldWidthAndCase('ｱﾞ')).toBe('アﾞ'); // ｱﾞ
  });
});

describe('英数記号は全半角・大小を畳む', () => {
  it('VIDEO/8 の 4 通りが等価', () => {
    const forms = ['VIDEO/8', 'video/8', 'ＶＩＤＥＯ／８', 'ｖｉｄｅｏ／８'];
    const normalized = forms.map(normalize);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('video/8');
  });

  it('全角数字は半角に畳まれる', () => {
    expect(normalize('２５０')).toBe('250');
  });
});

describe('否定形の検出', () => {
  it('否定形はエラーとして検出できる', () => {
    expect(isNegativeForm('反応させない')).toBe(true);
    expect(isNegativeForm('表示しない')).toBe(true);
  });

  it('肯定形は否定と判定しない', () => {
    expect(isNegativeForm('反応させる')).toBe(false);
    expect(isNegativeForm('表示する')).toBe(false);
  });

  it('ひらがなのみの語は対象外', () => {
    // 「ない」自体が単語のことがあるため、送り仮名としての否定だけを見る
    expect(isNegativeForm('ない')).toBe(false);
  });
});

describe('助詞の切り出し（構文判定用）', () => {
  it('とは を は より先に照合する', () => {
    expect(splitParticle('表示とは')).toEqual({ stem: '表示', particle: 'とは' });
    expect(splitParticle('表示は')).toEqual({ stem: '表示', particle: 'は' });
  });

  it('格助詞を切り出す', () => {
    expect(splitParticle('文字列を')).toEqual({ stem: '文字列', particle: 'を' });
    expect(splitParticle('変数に')).toEqual({ stem: '変数', particle: 'に' });
    expect(splitParticle('先頭から')).toEqual({ stem: '先頭', particle: 'から' });
  });

  it('助詞だけの語は切り出さない', () => {
    expect(splitParticle('とは')).toEqual({ stem: 'とは', particle: null });
    expect(splitParticle('は')).toEqual({ stem: 'は', particle: null });
  });

  it('切り出してから正規化すると定義名が取れる', () => {
    const { stem, particle } = splitParticle('売り上げ計上とは');
    expect(particle).toBe('とは');
    expect(normalize(stem)).toBe('売上計上');
  });
});

describe('分かち書きの区切り文字', () => {
  it('マニュアルに挙がっている 4 種だけが区切り', () => {
    for (const ch of ['\t', ' ', '　', ',', '，', '、']) {
      expect(isSeparator(ch)).toBe(true);
    }
    for (const ch of ['。', '・', '「', 'あ', '漢']) {
      expect(isSeparator(ch)).toBe(false);
    }
  });
});

describe('実ライブラリに出てくる語', () => {
  it('pmind/file の定義名が壊れない', () => {
    expect(normalize('表示')).toBe('表示');
    expect(normalize('一文字表示')).toBe('一文字表示');
    expect(normalize('改行')).toBe('改行');
    expect(normalize('ベルを鳴らす')).toBe('ベル鳴');
    expect(normalize('エラー出力をバッファリング')).toBe('エラー出力バッファリング');
    expect(normalize('桁数指定で数値表示')).toBe('桁数指定数値表示');
  });

  it('漢字が違えば別語になる（だから 等価 定義が要る）', () => {
    // pmind/file/coutput.src には
    //   エラー出力を標準出力に切り換えは　エラー出力を標準出力に切り替えと　等価。
    // という定義がある。正規化では 替 と 換 は畳まれないので、
    // これらを結ぶのは「等価」定義であってこの関数ではない。
    expect(normalize('エラー出力を標準出力に切り替え')).toBe('エラー出力標準出力切替');
    expect(normalize('エラー出力を標準出力に切り換え')).toBe('エラー出力標準出力切換');
    expect(normalize('エラー出力を標準出力に切り替え'))
      .not.toBe(normalize('エラー出力を標準出力に切り換え'));
  });
});
