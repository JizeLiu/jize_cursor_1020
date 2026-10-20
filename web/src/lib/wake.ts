const PUNCT_CHARS = /[\s,.!?;:'"“”‘’，。！？；：、…—\-()（）【】[\]{}《》]/;
const PUNCT_ALL = new RegExp(PUNCT_CHARS.source, 'g');

export function normalize(s: string): string {
  return s.toLowerCase().replace(PUNCT_ALL, '');
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export interface WakeMatch {
  word: string;
  /** 唤醒词在归一化文本中的结束位置，用于截取唤醒词之后的内容 */
  endIndex: number;
}

/**
 * 在识别文本中查找唤醒词。
 * fuzzy 为允许的编辑距离占词长比例（0 = 必须完全包含）。
 * 说明：没有拼音库时无法处理同音字，建议把常见误识别写法也加入唤醒词列表。
 */
export function matchWake(text: string, words: string[], fuzzy: number): WakeMatch | null {
  const t = normalize(text);
  for (const raw of words) {
    const w = normalize(raw);
    if (!w) continue;
    const idx = t.indexOf(w);
    if (idx >= 0) return { word: raw, endIndex: idx + w.length };
    const maxDist = Math.floor(w.length * fuzzy);
    if (maxDist <= 0) continue;
    for (let len = Math.max(1, w.length - 1); len <= w.length + 1; len++) {
      for (let i = 0; i + len <= t.length; i++) {
        if (levenshtein(t.slice(i, i + len), w) <= maxDist) return { word: raw, endIndex: i + len };
      }
    }
  }
  return null;
}

/** 取出归一化位置之后的原文内容。 */
export function textAfter(text: string, endIndex: number): string {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (count >= endIndex) return text.slice(i).replace(/^[\s,.!?;:，。！？；：、]+/, '');
    if (!PUNCT_CHARS.test(text[i])) count++;
  }
  return '';
}
