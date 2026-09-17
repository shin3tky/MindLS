/**
 * `.inf`（インフォメーションファイル）のパーサ。
 *
 * Mind のコンパイラは文法エラーのときだけ `.inf` を出す。書式はマニュアルに
 * 載っていないので、実物から起こした。実物は `fixtures/inf-corpus/collected/` にある。
 *
 * ```
 * undefined-word.src 3 行目でエラー。行内容は、
 * 	まったく存在しない単語し
 *       要因１："まったく存在しない単語"は未定義の単語です。
 *
 * 1 個のエラーが有ります。
 * ```
 *
 * 分かったこと。
 *
 *   ・**桁は無い。** 行番号と、その行の内容そのままと、要因だけ。
 *     当初は「EUC-JP のバイトオフセットが入っているので逆変換が要る」と見ていたが、
 *     そもそもオフセットが入っていない。桁は「引用された語を行の中から探す」で求める
 *   ・1 つの行に **要因が複数** 付くことがある（`要因１` `要因２`）
 *   ・末尾の「N 個のエラー」の N は **要因の総数**。行ブロックの数ではない
 *   ・複数のエラーはすべて報告される（最初の 1 件で止まらない）
 *   ・引用される語は、生の単語から**末尾の送り仮名を落としたもの**。
 *     `存在しない単語ひとつめし` は `"存在しない単語"` と出る
 */

import type { CompileDiagnostic } from './adapter.ts';

/** `<file> <N> 行目でエラー。行内容は、` */
const HEADER = /^(?<file>\S+)\s+(?<line>\d+)\s*行目でエラー。/;
/** `      要因１：<本文>` — 先頭の空白と全角の番号 */
const CAUSE = /^\s*要因[０-９0-9]+[：:](?<message>.*)$/;
/** `N 個のエラーが有ります。` */
const TOTAL = /^(?<count>\d+)\s*個のエラーが有ります。/;
/** 本文の中で単語を指す引用。半角のダブルクォートで囲まれる */
const QUOTED = /"([^"]+)"|「([^」]+)」/;

export interface InfCause {
  readonly message: string;
  /** 本文が引用している単語。無ければ null */
  readonly word: string | null;
}

export interface InfEntry {
  /** `.inf` に書かれていたファイル名 */
  readonly file: string;
  /** 0 始まりの行番号（`.inf` は 1 始まり） */
  readonly line: number;
  /** コンパイラが echo し返した、その行の内容 */
  readonly text: string;
  readonly causes: readonly InfCause[];
}

export interface InfReport {
  readonly entries: readonly InfEntry[];
  /** 末尾に書かれていたエラー数。書かれていなければ null */
  readonly total: number | null;
}

/** 本文から引用された単語を取り出す */
function quotedWord(message: string): string | null {
  const m = QUOTED.exec(message);
  if (m === null) return null;
  return m[1] ?? m[2] ?? null;
}

/**
 * `.inf` の本文（UTF-8 に変換済み）を解析する。
 *
 * 壊れた行は黙って読み飛ばす。コンパイラの版が変わって書式が動いても、
 * 拾えるものだけ拾って診断を出せるほうがよい。
 */
export function parseInf(text: string): InfReport {
  const lines = text.split(/\r?\n/);
  const entries: InfEntry[] = [];
  let total: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const totalMatch = TOTAL.exec(line);
    if (totalMatch?.groups !== undefined) {
      total = Number(totalMatch.groups['count']);
      continue;
    }

    const header = HEADER.exec(line);
    if (header?.groups === undefined) continue;

    // 次の行は、その行の内容がそのまま echo される
    const text_ = lines[i + 1] ?? '';
    i += 1;

    const causes: InfCause[] = [];
    while (i + 1 < lines.length) {
      const cause = CAUSE.exec(lines[i + 1]!);
      if (cause?.groups === undefined) break;
      const message = cause.groups['message']!.trim();
      causes.push({ message, word: quotedWord(message) });
      i += 1;
    }

    entries.push({
      file: header.groups['file']!,
      line: Number(header.groups['line']) - 1,
      text: text_,
      causes,
    });
  }

  return { entries, total };
}

/**
 * `.inf` の報告を、位置つきの診断に変える。
 *
 * `.inf` には桁が無いので、**引用された語を行の中から探して**桁を決める。
 * 引用が無い要因（「条件分岐や繰り返し文をアンバランスに使っています。」など）は
 * 行全体を指す。
 *
 * 行番号は EUC-JP の影ソースのものだが、変換は 1 行ずつの写しなので
 * 利用者の UTF-8 ソースと一対一に対応する。念のため、コンパイラが echo し返した
 * 行の内容と突き合わせ、食い違っていたら桁を諦めて行全体を指す。
 */
export function toDiagnostics(
  report: InfReport,
  sourceLines: readonly string[],
  file: string,
): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];

  for (const entry of report.entries) {
    const source = sourceLines[entry.line];
    const aligned = source !== undefined && source === entry.text;
    const line = source ?? entry.text;

    for (const cause of entry.causes) {
      const span = aligned ? spanOf(line, cause.word) : null;
      out.push({
        file,
        line: entry.line,
        character: span?.start ?? null,
        endCharacter: span?.end ?? null,
        severity: 'error',
        message: cause.message,
      });
    }

    // 要因が 1 つも読めなかったときも、行だけは伝える
    if (entry.causes.length === 0) {
      out.push({
        file,
        line: entry.line,
        character: null,
        endCharacter: null,
        severity: 'error',
        message: 'この行でコンパイルエラーになりました',
      });
    }
  }

  return out;
}

/**
 * 行の中で語が占める範囲。
 *
 * 引用される語は末尾の送り仮名が落ちた形なので、見つけた位置から
 * ひらがなが続くあいだは範囲を伸ばして、単語まるごとに下線が引かれるようにする。
 * 語が見つからなければ、行の空白を除いた範囲を返す。
 */
function spanOf(line: string, word: string | null): { start: number; end: number } | null {
  if (word !== null && word.length > 0) {
    const at = line.indexOf(word);
    if (at >= 0) {
      let end = at + word.length;
      while (end < line.length && isOkurigana(line[end]!)) end += 1;
      return { start: at, end };
    }
  }
  const start = line.search(/\S/);
  if (start < 0) return null;
  return { start, end: line.replace(/\s+$/, '').length };
}

function isOkurigana(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x3041 && c <= 0x309f) || ch === 'ー';
}
