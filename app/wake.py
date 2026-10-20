"""唤醒词匹配：判断 ASR 识别出的文字里有没有唤醒词。

没有拼音库，所以不能处理同音字（例如把「小智」识别成「小志」）。
办法有两个：用 fuzzy 容忍少量错字，或者把常见的误识别写法也加进唤醒词列表。
"""

import re
from dataclasses import dataclass

_PUNCT = re.compile(r"[\s,.!?;:'\"“”‘’，。！？；：、…—\-()（）【】\[\]{}《》]")


def normalize(text: str) -> str:
    return _PUNCT.sub("", text.lower())


def _edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


@dataclass
class WakeMatch:
    word: str  # 命中的唤醒词
    rest: str  # 唤醒词之后的内容（可能为空）


def match_wake_word(text: str, wake_words: list[str], fuzzy: float = 0.0) -> WakeMatch | None:
    """fuzzy：允许的编辑距离占唤醒词长度的比例，0 表示必须原样出现。"""
    norm = normalize(text)
    for word in wake_words:
        target = normalize(word)
        if not target:
            continue
        end = _find_end(norm, target, int(len(target) * fuzzy))
        if end is not None:
            return WakeMatch(word, _text_after(text, end))
    return None


def _find_end(norm: str, target: str, max_dist: int) -> int | None:
    idx = norm.find(target)
    if idx >= 0:
        return idx + len(target)
    if max_dist <= 0:
        return None
    for length in range(max(1, len(target) - 1), len(target) + 2):
        for i in range(len(norm) - length + 1):
            if _edit_distance(norm[i : i + length], target) <= max_dist:
                return i + length
    return None


def _text_after(text: str, norm_end: int) -> str:
    """norm_end 是「去掉标点后」的位置，这里换算回原文位置，取其后的内容。"""
    count = 0
    for i, ch in enumerate(text):
        if count >= norm_end:
            return text[i:].lstrip(" ,.!?;:，。！？；：、")
        if not _PUNCT.match(ch):
            count += 1
    return ""
