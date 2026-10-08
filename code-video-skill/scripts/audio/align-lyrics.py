#!/usr/bin/env python3
"""align-lyrics.py — 歌词对齐工具（音频工具层）

职责边界：歌词一律由用户提供，本工具只负责
"给用户提供的准确歌词打时间戳"，绝不用 ASR 听写凑歌词。

两种模式
--------
1. LRC 直读（自带时间戳，不需要音频）
       python align-lyrics.py --lrc song.lrc --out lyrics.json
   可选 `--audio`：用于时长校验与校验图（波形 + 歌词时间线）。
   可选 `--split-words`：把行级时间戳按权重推导成词级（中文按字、拉丁按词长），
   输出行会带 `"wordsSource": "split-estimated"` —— 明确标注这是**推导值**，
   不是真实对齐，只适合逐字高亮兜底。默认关闭（`words: []`）。

2. 纯文本对齐（无时间戳）
       python align-lyrics.py --audio song.mp3 --text lyrics.txt --out lyrics.json
   链路：Demucs 分离人声 → faster-whisper 词级时间戳 → 用用户歌词按序列比对
   校准（保留时间戳、以正确文本覆盖识别错字）→ 逐行逐词时间轴。

输出 schema（与 6.3 一致）
--------------------------
    [{"text": "There was a sun", "startMs": 5230, "endMs": 8120,
      "words": [{"word": "There", "startMs": 5230, "endMs": 5560}]}]

LRC 路径没有词级时间戳，`words` 输出空数组；消费端如需逐字卡拉 OK，可按字符
均分（见 README-lyrics.md「逐字按字符均分」）。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:  # 仅用于类型标注：numpy 等重依赖保持延迟导入
    import numpy as np

# 控制台/管道统一 UTF-8 输出：中文日志在 GBK 默认编码下会被 agent 读成乱码
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# ----------------------------------------------------------------- 常量

DEFAULT_WHISPER_MODEL = "small"
DEFAULT_SEPARATION_MODEL = "htdemucs"
DEFAULT_LAST_LINE_MS = 4000       # LRC 末行无后续时间戳时的默认持续时长
FALLBACK_UNIT_MS = 300.0          # 完全没有锚点时的每单位权重估算毫秒数
FUZZY_THRESHOLD = 0.72            # 替换块内模糊配对阈值
MAX_LINE_GAP_MS = 1200            # 校验时允许的"末行超出音频时长"容差
WORDS_SOURCE_SPLIT = "split-estimated"   # 词级时间戳来自行级均分推导（非真实对齐）


# ----------------------------------------------------------------- 数据结构


@dataclass(frozen=True)
class AsrWord:
    """ASR 输出的一个词及其时间戳（毫秒）。"""

    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class Token:
    """用户歌词中的一个可对齐单元（英文词 / 中文字 / 数字）。"""

    text: str
    norm: str
    line_index: int
    weight: float


@dataclass
class AlignedWord:
    word: str
    start_ms: int
    end_ms: int

    def to_dict(self) -> dict:
        return {"word": self.word, "startMs": self.start_ms, "endMs": self.end_ms}


@dataclass
class AlignedLine:
    text: str
    start_ms: int
    end_ms: int
    words: list[AlignedWord] = field(default_factory=list)
    words_source: str | None = None   # 仅当词级时间戳是"推导"而非"真实对齐"时标注

    def to_dict(self) -> dict:
        payload = {
            "text": self.text,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "words": [w.to_dict() for w in self.words],
        }
        if self.words_source:
            payload["wordsSource"] = self.words_source
        return payload


@dataclass
class AlignStats:
    total_tokens: int = 0
    matched_tokens: int = 0
    asr_words: int = 0
    used_spread_fallback: bool = False

    @property
    def coverage(self) -> float:
        return self.matched_tokens / self.total_tokens if self.total_tokens else 0.0


# ----------------------------------------------------------------- 通用工具


def log(message: str) -> None:
    print(f"[align-lyrics] {message}", flush=True)


class AlignError(RuntimeError):
    """可预期的失败（依赖缺失、文件不可读、无有效歌词等）。"""


def read_text_file(path: Path) -> str:
    """读取文本文件，兼容 UTF-8 / GB18030 编码。"""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise AlignError(f"无法读取文件 {path}: {exc}") from exc
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise AlignError(f"文本编码无法识别（尝试 utf-8 / gb18030）: {path}")


# ----------------------------------------------------------------- 文本处理

_TOKEN_RE = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]"      # CJK 表意文字：逐字
    r"|[\u3040-\u30ff]"                                 # 日文假名：逐字
    r"|[\uac00-\ud7af]"                                 # 韩文音节：逐字
    r"|\d+(?:[.,]\d+)+|\d+"                             # 数字（含小数）
    r"|[^\W\d_]+(?:['’\-][^\W\d_]+)*",                  # 拉丁/西里尔等字母词
    re.UNICODE,
)

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")


def normalize_token(token: str) -> str:
    """用于比对的规范化形式：NFKC + 大小写折叠 + 弯引号统一。"""
    return unicodedata.normalize("NFKC", token).casefold().replace("’", "'")


def tokenize(text: str) -> list[str]:
    """把一行歌词切成对齐单元（标点丢弃，中文按字，英文按词）。"""
    return [m.group(0) for m in _TOKEN_RE.finditer(unicodedata.normalize("NFKC", text))]


def _token_weight(token: str) -> float:
    """插值权重：中文按字数，拉丁词按约 3 字符一个音节估算。"""
    if _CJK_RE.search(token):
        return float(len(token))
    return max(1.0, len(token) / 3.0)


_META_TAG_RE = re.compile(r"^\s*\[[a-zA-Z#]+:[^\]]*\]\s*$")
_LRC_LINE_RE = re.compile(r"^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]")


def load_lyric_lines(path: Path) -> list[str]:
    """读取纯文本歌词：每行一句，去掉空行与 LRC 元数据标签行。"""
    lines = []
    for raw in read_text_file(path).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        text = raw.replace("\ufeff", "").strip()
        if not text or _META_TAG_RE.match(text):
            continue
        lines.append(text)
    if not lines:
        raise AlignError(f"歌词文本为空: {path}")
    if sum(1 for line in lines if _LRC_LINE_RE.match(line)) >= 2:
        log("警告：文本中包含 LRC 时间戳，纯文本模式会把它当歌词内容；建议改用 --lrc 模式")
    return lines


# ----------------------------------------------------------------- LRC 解析

_LRC_TS_RE = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_LRC_OFFSET_RE = re.compile(r"\[offset:\s*([+-]?\d+)\s*\]", re.IGNORECASE)


def _lrc_fraction_to_ms(fraction: str | None) -> int:
    """`mm:ss.xx` 的 xx 是厘秒，三位是毫秒，一位是十分之一秒。"""
    if not fraction:
        return 0
    if len(fraction) == 1:
        return int(fraction) * 100
    if len(fraction) == 2:
        return int(fraction) * 10
    return int(fraction[:3])


def parse_lrc(text: str, last_line_ms: int = DEFAULT_LAST_LINE_MS) -> list[AlignedLine]:
    """解析 LRC 文本为行级时间轴（`words` 为空；LRC 无词级时间戳）。"""
    offset_ms = 0
    offset_match = _LRC_OFFSET_RE.search(text)
    if offset_match:
        offset_ms = int(offset_match.group(1))

    entries: list[tuple[int, str]] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.replace("\ufeff", "")
        stamps = list(_LRC_TS_RE.finditer(line))
        if not stamps:
            continue
        lyric = _LRC_TS_RE.sub("", line).strip()
        if not lyric:
            continue
        for match in stamps:
            minutes, seconds, fraction = match.group(1), match.group(2), match.group(3)
            start_ms = (int(minutes) * 60 + int(seconds)) * 1000 + _lrc_fraction_to_ms(fraction)
            # LRC offset 约定：正 offset 让歌词提前出现（time = time - offset）
            entries.append((max(0, start_ms - offset_ms), lyric))

    if not entries:
        raise AlignError("LRC 中未解析到任何带时间戳的歌词行")

    entries.sort(key=lambda item: item[0])
    lines: list[AlignedLine] = []
    for index, (start_ms, lyric) in enumerate(entries):
        if index + 1 < len(entries):
            end_ms = entries[index + 1][0]
        else:
            end_ms = start_ms + last_line_ms
        lines.append(AlignedLine(lyric, start_ms, max(start_ms + 1, end_ms), []))
    return lines


# --------------------------------------------------- LRC 词级均分（推导值）


def split_line_words(text: str, start_ms: int, end_ms: int) -> list[AlignedWord]:
    """把行级时间戳按权重推导成词级时间戳（**非真实对齐**）。

    权重：中文/日文/韩文按字数，拉丁词按 `max(1, 字符数 / 3)`（≈ 音节数）。
    行内顺序分配，首词起点 = 行起点、末词终点 = 行终点，词间不重叠、不越行界。
    行跨度连"每词 1 ms"都放不下时返回空列表（保持 `words: []`，不产出无效词）。
    """
    tokens = tokenize(text)
    span = end_ms - start_ms
    if not tokens or span < len(tokens):
        return []

    weights = [_token_weight(token) for token in tokens]
    total = sum(weights)
    words: list[AlignedWord] = []
    ideal = float(start_ms)
    cursor = start_ms
    for index, (token, weight) in enumerate(zip(tokens, weights)):
        ideal += span * weight / total
        if index == len(tokens) - 1:
            word_end = end_ms
        else:
            # 给剩余每个词都留够 1 ms，避免舍入把后续词挤出行尾
            limit = end_ms - (len(tokens) - index - 1)
            word_end = min(limit, max(cursor + 1, round(ideal)))
        words.append(AlignedWord(token, cursor, word_end))
        cursor = word_end
    return words


def apply_split_words(lines: list[AlignedLine]) -> tuple[int, int]:
    """给所有行补词级推导时间戳，返回 (成功行数, 跳过的行数)。"""
    split, skipped = 0, 0
    for line in lines:
        words = split_line_words(line.text, line.start_ms, line.end_ms)
        if words:
            line.words = words
            line.words_source = WORDS_SOURCE_SPLIT
            split += 1
        else:
            skipped += 1
    return split, skipped


# ----------------------------------------------------------------- 音频解码


def _decode_with_ffmpeg(path: Path, sample_rate: int = 16000) -> tuple[np.ndarray, int]:
    """回退方案：用 ffmpeg 解成 16k 单声道 WAV 再读。"""
    import numpy as np
    import soundfile as sf

    with tempfile.TemporaryDirectory(prefix="align-lyrics-") as tmp:
        wav_path = Path(tmp) / "decoded.wav"
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(path),
            "-ac", "1", "-ar", str(sample_rate), "-f", "wav", str(wav_path),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True)
        except FileNotFoundError as exc:
            raise AlignError("soundfile 无法解码该文件，且未找到 ffmpeg，请安装 ffmpeg 或改用 wav/mp3/flac") from exc
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.decode("utf-8", "replace").strip()
            raise AlignError(f"ffmpeg 解码失败: {detail or path}") from exc
        data, sr = sf.read(str(wav_path), dtype="float32", always_2d=True)
        return np.asarray(data), int(sr)


def decode_audio_mono(path: Path) -> tuple[np.ndarray, int]:
    """解码音频为单声道 float32；返回 (samples, sample_rate)。"""
    import numpy as np

    if not path.exists():
        raise AlignError(f"音频文件不存在: {path}")
    try:
        import soundfile as sf

        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception:  # noqa: BLE001 —— 解码失败原因多样（缺库/容器不支持），统一回退 ffmpeg
        data, sr = _decode_with_ffmpeg(path)

    pcm = np.asarray(data)
    if pcm.ndim == 2 and pcm.shape[1] > 1:
        pcm = pcm.mean(axis=1)
    pcm = pcm.reshape(-1).astype("float32", copy=False)
    if pcm.size == 0:
        raise AlignError(f"音频解码结果为空: {path}")
    return pcm, int(sr)


def detect_lead_silence_ms(
    pcm: np.ndarray,
    sample_rate: int,
    *,
    min_silence_ms: int = 300,
    frame_ms: float = 20.0,
    threshold_ratio: float = 0.02,
    pad_ms: int = 100,
) -> int:
    """估计前导静音长度（毫秒）；不足 min_silence_ms 时返回 0。

    Whisper 对"开头就是静音"的音频常把首词起点锚到 0，导致首句整体偏早；
    裁掉前导静音再转写、把偏移加回去，首词起点即落在真实起唱位置。
    """
    import numpy as np

    frame = max(1, int(sample_rate * frame_ms / 1000.0))
    if pcm.size < frame * 2:
        return 0
    trimmed = pcm[: pcm.size - (pcm.size % frame)]
    envelope = np.abs(trimmed.reshape(-1, frame)).max(axis=1)
    peak = float(envelope.max())
    if peak <= 0.0:
        return 0
    above = np.flatnonzero(envelope >= max(peak * threshold_ratio, 1e-4))
    if above.size == 0:
        return 0
    onset_ms = int(above[0] * frame_ms) - pad_ms
    return onset_ms if onset_ms >= min_silence_ms else 0


def prepare_asr_audio(source: Path, work_dir: Path, trim_ms: int) -> Path:
    """把待转写音频统一成 16k 单声道 WAV；trim_ms > 0 时裁掉前导静音。"""
    target = work_dir / "asr-input.wav"
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if trim_ms > 0:
        command += ["-ss", f"{trim_ms / 1000.0:.3f}"]
    command += ["-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", str(target)]
    try:
        subprocess.run(command, check=True, capture_output=True)
    except FileNotFoundError as exc:
        raise AlignError("未找到 ffmpeg，无法预处理待转写音频") from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace").strip()
        raise AlignError(f"ffmpeg 预处理失败: {detail}") from exc
    return target


# ----------------------------------------------------------------- 人声分离


def separate_vocals(audio_path: Path, work_dir: Path, model: str, device: str) -> Path:
    """用 Demucs 分离人声轨，返回 vocals.wav 路径。"""
    command = [
        sys.executable, "-m", "demucs.separate",
        "-n", model, "--two-stems=vocals",
        "-d", device,
        "-o", str(work_dir),
        str(audio_path),
    ]
    log(f"Demucs 分离人声轨（模型 {model} / {device}）…")
    result = subprocess.run(
        command, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False
    )
    if result.returncode != 0:
        tail = "\n".join((result.stderr or result.stdout or "").strip().splitlines()[-15:])
        raise AlignError(f"Demucs 分离失败（退出码 {result.returncode}）:\n{tail}")
    candidates = sorted(work_dir.glob(f"*/{audio_path.stem}/vocals.*"))
    if not candidates:
        raise AlignError(f"Demucs 未产出 vocals 文件，目录: {work_dir}")
    return candidates[0]


# ----------------------------------------------------------------- 词级转写


def transcribe_words(
    audio_path: Path,
    *,
    model_name: str,
    device: str,
    compute_type: str,
    language: str | None,
    vad: bool,
    model_dir: Path | None = None,
    offset_ms: int = 0,
) -> list[AsrWord]:
    """faster-whisper 词级转写。本工具只取时间戳，最终文本一律以用户歌词为准。"""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise AlignError(
            "缺少 faster-whisper，请先安装：\n"
            f'  "{sys.executable}" -m pip install faster-whisper'
        ) from exc

    kwargs = {"device": device, "compute_type": compute_type}
    if model_dir is not None:
        kwargs["download_root"] = str(model_dir)
    model = WhisperModel(model_name, **kwargs)
    try:
        segments, info = model.transcribe(
            str(audio_path),
            language=language,
            word_timestamps=True,
            vad_filter=vad,
            condition_on_previous_text=False,
            beam_size=5,
        )
    except TypeError as exc:
        # faster-whisper 1.2.x 依赖 av.open(metadata_errors=...)，PyAV 19 移除了该参数
        if "metadata_errors" in str(exc):
            raise AlignError(
                "PyAV 版本不兼容：faster-whisper 需要 av.open(metadata_errors=...)，"
                '而当前 PyAV 已移除该参数。请降级安装：\n'
                f'  "{sys.executable}" -m pip install "av==18.1.0"'
            ) from exc
        raise

    words: list[AsrWord] = []
    for segment in segments:  # 生成器：边解码边产出
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                words.append(AsrWord(
                    text,
                    int(word.start * 1000) + offset_ms,
                    int(word.end * 1000) + offset_ms,
                ))

    detected = getattr(info, "language", None) or (language or "?")
    log(f"转写完成：语言 {detected}，词数 {len(words)}，模型 {model_name} / {device} / {compute_type}")
    return _sanitize_asr_words(words)


def _sanitize_asr_words(words: list[AsrWord]) -> list[AsrWord]:
    """按起始时间排序并修正零长度 / 轻微重叠。"""
    ordered = sorted(words, key=lambda w: (w.start_ms, w.end_ms))
    result: list[AsrWord] = []
    for word in ordered:
        start = word.start_ms if not result else max(word.start_ms, result[-1].end_ms)
        end = max(word.end_ms, start + 20)
        result.append(AsrWord(word.text, start, end))
    return result


# ----------------------------------------------------------------- 对齐


def _similarity(left: str, right: str) -> float:
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0
    if min(len(left), len(right)) <= 2 and left[0] != right[0]:
        return 0.0
    return SequenceMatcher(None, left, right, autojunk=False).ratio()


def _pair_replace_block(
    user_norm: list[str],
    asr_norm: list[str],
    i1: int, i2: int, j1: int, j2: int,
    pairs: list[int | None],
) -> None:
    """替换块内配对：数量相同直接一一对应，否则做局部贪心模糊匹配。"""
    if i2 - i1 == j2 - j1:
        for offset in range(i2 - i1):
            pairs[i1 + offset] = j1 + offset
        return

    left, right = i1, j1
    while left < i2 and right < j2:
        score = _similarity(user_norm[left], asr_norm[right])
        if score >= FUZZY_THRESHOLD:
            pairs[left] = right
            left += 1
            right += 1
            continue
        skip_asr = (
            _similarity(user_norm[left], asr_norm[right + 1]) if right + 1 < j2 else -1.0
        )
        skip_user = (
            _similarity(user_norm[left + 1], asr_norm[right]) if left + 1 < i2 else -1.0
        )
        if skip_asr >= FUZZY_THRESHOLD and skip_asr >= skip_user:
            right += 1          # ASR 多识别出的词，跳过
        elif skip_user >= FUZZY_THRESHOLD and skip_user > skip_asr:
            left += 1           # 用户歌词中的词在 ASR 缺失，留给插值
        else:
            pairs[left] = right  # 尽力配对，文本仍以用户歌词为准
            left += 1
            right += 1


def _match_tokens(user_norm: list[str], asr_norm: list[str]) -> list[int | None]:
    """按序列比对把用户 token 映射到 ASR 词下标（未匹配为 None）。"""
    matcher = SequenceMatcher(a=user_norm, b=asr_norm, autojunk=False)
    pairs: list[int | None] = [None] * len(user_norm)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                pairs[i1 + offset] = j1 + offset
        elif tag == "replace":
            _pair_replace_block(user_norm, asr_norm, i1, i2, j1, j2, pairs)
        # delete / insert：用户缺失或 ASR 多余，均无需处理
    return pairs


def _mean_unit_ms(times: list[tuple[int, int] | None], tokens: list[Token]) -> float:
    samples = []
    for token, time in zip(tokens, times):
        if time is None:
            continue
        start, end = time
        if end > start:
            samples.append((end - start) / max(token.weight, 0.1))
    if not samples:
        return FALLBACK_UNIT_MS
    return sum(samples) / len(samples)


def _fill_run(
    times: list[tuple[int, int] | None],
    tokens: list[Token],
    lo: int,
    hi: int,
    window: tuple[float, float],
) -> None:
    """把 tokens[lo:hi] 按权重铺进 window（毫秒）。"""
    weights = [tokens[i].weight for i in range(lo, hi)]
    total = sum(weights)
    start, end = window
    available = max(0.0, end - start)
    if total <= 0 or available <= 0:
        available = max(float(len(weights)), available)
        weights = [1.0] * len(weights)
        total = float(len(weights))
    cursor = start
    for offset, weight in enumerate(weights):
        share = available * weight / total
        word_start = round(cursor)
        word_end = round(cursor + share)
        if word_end <= word_start:
            word_end = word_start + 1
        times[lo + offset] = (word_start, max(word_start + 1, word_end))
        cursor += share


def _assign_times(
    tokens: list[Token],
    matched: list[int | None],
    asr_words: list[AsrWord],
    duration_ms: int,
) -> list[tuple[int, int]]:
    """把命中的 ASR 时间戳落到用户 token 上，未命中的按邻居插值。"""
    times: list[tuple[int, int] | None] = [None] * len(tokens)
    for index, asr_index in enumerate(matched):
        if asr_index is not None:
            word = asr_words[asr_index]
            times[index] = (word.start_ms, word.end_ms)

    anchors = [index for index, time in enumerate(times) if time is not None]
    if not anchors:
        _fill_run(times, tokens, 0, len(tokens), (0.0, float(duration_ms)))
    else:
        unit_ms = _mean_unit_ms(times, tokens)
        anchor_spans = [cast(tuple[int, int], times[index]) for index in anchors]

        head = anchors[0]
        if head > 0:
            estimate = sum(tokens[i].weight for i in range(head)) * unit_ms
            first_start = float(anchor_spans[0][0])
            _fill_run(times, tokens, 0, head, (max(0.0, first_start - estimate), first_start))

        for anchor_pos in range(len(anchors) - 1):
            prev_index, next_index = anchors[anchor_pos], anchors[anchor_pos + 1]
            if next_index == prev_index + 1:
                continue
            window = (float(anchor_spans[anchor_pos][1]), float(anchor_spans[anchor_pos + 1][0]))
            _fill_run(times, tokens, prev_index + 1, next_index, window)

        tail = anchors[-1]
        if tail < len(tokens) - 1:
            estimate = sum(tokens[i].weight for i in range(tail + 1, len(tokens))) * unit_ms
            last_end = float(anchor_spans[-1][1])
            limit = float(duration_ms) if duration_ms > 0 else last_end + estimate
            _fill_run(times, tokens, tail + 1, len(tokens), (last_end, min(limit, last_end + estimate)))

    # 全局单调收敛：起点不早于前一个词的终点
    result: list[tuple[int, int]] = []
    cursor = 0
    for time in times:
        if time is None:  # 理论上不会发生
            time = (cursor, cursor + 1)
        start = max(int(time[0]), cursor)
        end = max(int(time[1]), start + 1)
        result.append((start, end))
        cursor = end
    return result


def _build_lines(
    texts: list[str],
    tokens: list[Token],
    times: list[tuple[int, int]],
    duration_ms: int,
) -> list[AlignedLine]:
    """按行归组词时间轴；无 token 的行（如纯符号行）夹在前后行之间。"""
    grouped: dict[int, list[tuple[Token, tuple[int, int]]]] = {}
    for token, time in zip(tokens, times):
        grouped.setdefault(token.line_index, []).append((token, time))

    lines: list[AlignedLine] = []
    for index, text in enumerate(texts):
        entries = grouped.get(index)
        if entries:
            words = [AlignedWord(token.text, time[0], time[1]) for token, time in entries]
            lines.append(AlignedLine(text, words[0].start_ms, words[-1].end_ms, words))
        else:
            lines.append(AlignedLine(text, -1, -1, []))

    # 连续的无 token 行（纯符号行等）：在前后行之间的空隙里均分
    index = 0
    while index < len(lines):
        if lines[index].start_ms >= 0:
            index += 1
            continue
        run_end = index
        while run_end < len(lines) and lines[run_end].start_ms < 0:
            run_end += 1
        count = run_end - index
        previous_end = next(
            (lines[k].end_ms for k in range(index - 1, -1, -1) if lines[k].start_ms >= 0), 0
        )
        following_start = next(
            (lines[k].start_ms for k in range(run_end, len(lines)) if lines[k].start_ms >= 0), None
        )
        if following_start is None:
            fallback = int(FALLBACK_UNIT_MS) * count
            limit = duration_ms if duration_ms > previous_end else previous_end + fallback
        else:
            limit = max(following_start, previous_end + count)
        step = max(count, limit - previous_end) / count
        cursor = float(previous_end)
        for offset in range(count):
            start = round(cursor)
            end = round(cursor + step)
            lines[index + offset].start_ms = start
            lines[index + offset].end_ms = max(start + 1, end)
            cursor += step
        index = run_end

    for index in range(len(lines) - 1):
        if lines[index].end_ms > lines[index + 1].start_ms:
            lines[index].end_ms = max(lines[index].start_ms + 1, lines[index + 1].start_ms)
    return lines


def align_lyrics(
    texts: list[str],
    asr_words: list[AsrWord],
    duration_ms: int,
) -> tuple[list[AlignedLine], AlignStats]:
    """核心对齐：用户歌词分词 → 与 ASR 词序列比对 → 时间戳落到用户文本上。"""
    tokens: list[Token] = []
    for line_index, text in enumerate(texts):
        for raw in tokenize(text):
            norm = normalize_token(raw)
            if norm:
                tokens.append(Token(raw, norm, line_index, _token_weight(raw)))
    if not tokens:
        raise AlignError("歌词中没有可用于对齐的字符")

    stats = AlignStats(total_tokens=len(tokens))
    user_norm = [token.norm for token in tokens]
    asr_pairs = [(normalize_token(word.text), word) for word in asr_words]
    asr_norm = [norm for norm, _ in asr_pairs if norm]
    asr_words = [word for norm, word in asr_pairs if norm]
    stats.asr_words = len(asr_words)

    if asr_norm:
        matched = _match_tokens(user_norm, asr_norm)
    else:
        log("警告：ASR 未返回任何词，全部歌词时间戳将由音频时长均摊（结果仅供占位）")
        matched = [None] * len(tokens)
        stats.used_spread_fallback = True

    stats.matched_tokens = sum(1 for item in matched if item is not None)
    if stats.matched_tokens == 0:
        log("警告：用户歌词与 ASR 结果无任何可匹配项，时间戳按音频时长均摊（结果仅供占位）")
        stats.used_spread_fallback = True

    times = _assign_times(tokens, matched, asr_words, duration_ms)
    lines = _build_lines(texts, tokens, times, duration_ms)
    return lines, stats


# ----------------------------------------------------------------- 校验与可视化


def validate(lines: list[AlignedLine], duration_ms: int | None, expected_lines: int) -> list[str]:
    """返回校验警告列表（空列表 = 全部通过）。"""
    warnings: list[str] = []
    if len(lines) != expected_lines:
        warnings.append(f"行数 {len(lines)} != 文本行数 {expected_lines}")
    if not lines:
        return warnings
    if lines[0].start_ms < 0:
        warnings.append("首行起始时间为负")
    for index, line in enumerate(lines):
        if line.end_ms <= line.start_ms:
            warnings.append(f"第 {index + 1} 行 endMs <= startMs（{line.start_ms} → {line.end_ms}）")
        if index and line.start_ms < lines[index - 1].end_ms:
            warnings.append(
                f"第 {index + 1} 行与上一行时间重叠（{line.start_ms} < {lines[index - 1].end_ms}）"
            )
        previous_end = None
        for word in line.words:
            if word.end_ms <= word.start_ms:
                warnings.append(f"第 {index + 1} 行存在零长度词 {word.word!r}")
            if previous_end is not None and word.start_ms < previous_end:
                warnings.append(f"第 {index + 1} 行词时间非单调：{word.word!r}")
            if word.start_ms < line.start_ms or word.end_ms > line.end_ms:
                warnings.append(f"第 {index + 1} 行词 {word.word!r} 越出行边界")
            previous_end = word.end_ms
    if duration_ms:
        if lines[-1].end_ms > duration_ms + MAX_LINE_GAP_MS:
            warnings.append(
                f"末行结束 {lines[-1].end_ms}ms 超出音频时长 {duration_ms}ms"
                f"（容差 {MAX_LINE_GAP_MS}ms）"
            )
        if lines[0].start_ms > duration_ms:
            warnings.append(f"首行起始 {lines[0].start_ms}ms 已超出音频时长 {duration_ms}ms")
    return warnings


def render_check_plot(
    pcm: np.ndarray,
    sample_rate: int,
    lines: list[AlignedLine],
    out_path: Path,
    title: str,
    subtitle: str,
    note: str | None = None,
) -> Path:
    """校验图：上半波形 + 歌词行时间线，下半逐行时间条与词级刻度。"""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np

    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False

    samples = np.asarray(pcm, dtype="float32")
    duration_s = samples.size / sample_rate
    x_max = max(duration_s, 0.1) * 1.01
    points = 2400
    step = max(1, samples.size // points)
    trimmed = samples[: samples.size - (samples.size % step)]
    envelope = np.abs(trimmed.reshape(-1, step)).max(axis=1)
    times = (np.arange(envelope.size) * step + step / 2) / sample_rate

    header = f"{title}\n{subtitle}" + (f"\n注意：{note}" if note else "")
    height = min(24.0, max(6.0, 3.0 + 0.20 * len(lines)))
    figure, (wave_ax, line_ax) = plt.subplots(
        2, 1, figsize=(13.0, height), sharex=True, gridspec_kw={"height_ratios": [1.0, 1.8]}
    )

    wave_ax.fill_between(times, envelope, -envelope, color="#4c78a8", alpha=0.35, linewidth=0)
    wave_ax.plot(times, envelope, color="#3b5f8a", linewidth=0.6)
    wave_ax.axhline(0.0, color="#999999", linewidth=0.5)
    wave_ax.set_ylabel("振幅")
    wave_ax.set_title(header, fontsize=11)
    wave_ax.grid(alpha=0.2, linewidth=0.5)

    for index, line in enumerate(lines):
        start_s, end_s = line.start_ms / 1000.0, line.end_ms / 1000.0
        color = "#f58518" if index % 2 == 0 else "#54a24b"
        wave_ax.axvspan(start_s, end_s, color=color, alpha=0.12, linewidth=0)

        bar_left = min(max(start_s, 0.0), x_max)
        bar_right = min(max(end_s, 0.0), x_max)
        if bar_right > bar_left:
            edge = "#d62728" if end_s > x_max else color
            line_ax.barh(index, bar_right - bar_left, left=bar_left, height=0.62,
                         color=color, alpha=0.55, edgecolor=edge, linewidth=0.6)
        else:
            # 整行落在音频时长之外：右侧边缘标记，提示时间轴需要检查
            line_ax.plot([x_max], [index], marker=">", color="#d62728", markersize=5)
        for word in line.words:
            tick = min(max(word.start_ms / 1000.0, 0.0), x_max)
            line_ax.plot([tick, tick], [index - 0.31, index + 0.31], color="#2b2b2b",
                         linewidth=0.5, alpha=0.55, zorder=3)

        label = line.text if len(line.text) <= 42 else line.text[:41] + "…"
        align_right = bar_left > x_max * 0.86
        label_x = x_max - 0.03 if align_right else min(bar_left, x_max) + 0.05
        line_ax.text(label_x, index, f"{index + 1:>3} {label}", va="center",
                     ha="right" if align_right else "left", fontsize=8, color="#1a1a1a",
                     clip_on=True)

    line_ax.set_ylim(-0.8, len(lines) - 0.2)
    line_ax.invert_yaxis()
    line_ax.set_xlim(0.0, x_max)
    line_ax.set_xlabel("时间（秒）")
    line_ax.set_ylabel("歌词行")
    line_ax.grid(axis="x", alpha=0.25, linewidth=0.5)
    for spine in ("top", "right"):
        wave_ax.spines[spine].set_visible(False)
        line_ax.spines[spine].set_visible(False)

    figure.tight_layout()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(out_path, dpi=140, bbox_inches="tight")
    plt.close(figure)
    return out_path


# ----------------------------------------------------------------- CLI

EXAMPLES = """\
示例
  LRC 直读：
    python align-lyrics.py --lrc song.lrc --out lyrics.json
    python align-lyrics.py --lrc song.lrc --audio song.mp3 --out lyrics.json

  纯文本对齐（Demucs + faster-whisper）：
    python align-lyrics.py --audio song.mp3 --text lyrics.txt --out lyrics.json
    python align-lyrics.py --audio vocal.wav --text lyrics.txt --no-separate
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="align-lyrics.py",
        description="歌词对齐：LRC 直读 / 纯文本对齐（Demucs 人声分离 + faster-whisper 词级时间戳 + 用户歌词校准）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=EXAMPLES,
    )
    parser.add_argument("--lrc", metavar="FILE", help="模式 1：LRC 文件（带时间戳，无需音频）")
    parser.add_argument("--audio", metavar="FILE", help="模式 2：音频文件；模式 1 下可选（用于时长校验与校验图）")
    parser.add_argument("--text", metavar="FILE", help="模式 2：纯文本歌词（每行一句，无时间戳）")
    parser.add_argument("--out", metavar="FILE", default="lyrics.json", help="输出 JSON 路径（默认 lyrics.json）")
    parser.add_argument("--plot", metavar="FILE", help="校验图 PNG 路径（默认 <out>-check.png）")
    parser.add_argument("--no-plot", action="store_true", help="不生成校验图")
    parser.add_argument("--last-line-ms", type=int, default=DEFAULT_LAST_LINE_MS,
                        help=f"LRC 末行无后续时间戳时的持续时长（默认 {DEFAULT_LAST_LINE_MS}）")
    parser.add_argument("--split-words", action="store_true",
                        help="LRC 模式：把行级时间戳按权重推导成词级（标注 wordsSource=\""
                             + WORDS_SOURCE_SPLIT + "\"，属推导值，默认关闭）")
    parser.add_argument("--strict", action="store_true", help="校验出现警告时以非零码退出")

    group = parser.add_argument_group("纯文本对齐选项")
    group.add_argument("--no-separate", action="store_true", help="跳过 Demucs 人声分离（纯人声素材可跳过）")
    group.add_argument("--separation-model", default=DEFAULT_SEPARATION_MODEL, help="Demucs 模型（默认 htdemucs）")
    group.add_argument("--model", default=DEFAULT_WHISPER_MODEL, help=f"faster-whisper 模型（默认 {DEFAULT_WHISPER_MODEL}）")
    group.add_argument("--model-dir", metavar="DIR", help="模型下载/缓存目录（默认 HuggingFace 缓存）")
    group.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"], help="推理设备（默认 auto）")
    group.add_argument("--compute-type", default="auto", help="计算精度（auto / int8 / float16 / float32）")
    group.add_argument("--language", default=None, help="语言提示（如 en / zh）；默认自动检测")
    group.add_argument("--vad", action="store_true", help="启用 Silero VAD 过滤静音段")
    group.add_argument("--no-trim", action="store_true", help="不裁前导静音（默认会裁掉并回加时间戳）")
    return parser


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001 —— 探测设备失败不应中断命令，退回 CPU
        return "cpu"


def resolve_compute_type(requested: str, device: str) -> str:
    if requested != "auto":
        return requested
    return "float16" if device == "cuda" else "int8"


def write_json(path: Path, lines: list[AlignedLine]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = [line.to_dict() for line in lines]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_plot_path(args: argparse.Namespace, out_path: Path, has_audio: bool) -> Path | None:
    if args.no_plot:
        return None
    if args.plot:
        return Path(args.plot)
    if not has_audio:
        return None
    return out_path.with_name(f"{out_path.stem}-check.png")


def print_report(lines: list[AlignedLine], stats: AlignStats | None, warnings: list[str]) -> None:
    if stats is not None:
        log(f"对齐覆盖：{stats.matched_tokens}/{stats.total_tokens} 词命中"
            f"（{stats.coverage * 100:.1f}%），ASR 词数 {stats.asr_words}")
        if stats.used_spread_fallback:
            log("注意：本次结果包含均摊占位时间戳，精度不可靠")
    if warnings:
        for warning in warnings:
            log(f"[校验警告] {warning}")
    else:
        log("[校验] 通过：行数一致、时间单调、末行未超时长")


def run_lrc_mode(args: argparse.Namespace, lrc_path: Path, out_path: Path) -> int:
    log(f"模式 1（LRC 直读）: {lrc_path}")
    lines = parse_lrc(read_text_file(lrc_path), last_line_ms=args.last_line_ms)

    duration_ms: int | None = None
    pcm = None
    sample_rate = 0
    if args.audio:
        audio_path = Path(args.audio)
        pcm, sample_rate = decode_audio_mono(audio_path)
        duration_ms = int(pcm.size / sample_rate * 1000)
        log(f"音频时长：{duration_ms / 1000:.2f}s")
        if lines[-1].end_ms > duration_ms:
            lines[-1].end_ms = max(lines[-1].start_ms + 1, duration_ms)

    split_note = "无"
    if args.split_words:
        split, skipped = apply_split_words(lines)
        split_note = f"{split} 行均分推导（非真实对齐）"
        if skipped:
            split_note += f"，{skipped} 行时长不足未拆分"
        log(f"词级均分：{split} 行推导完成，wordsSource=\"{WORDS_SOURCE_SPLIT}\""
            + (f"；{skipped} 行时长不足以拆分，保持 words: []" if skipped else ""))
        log("注意：推导时间戳不反映真实发音位置，仅作逐字高亮兜底；需要真实词级请用纯文本对齐模式")

    warnings = validate(lines, duration_ms, expected_lines=len(lines))
    write_json(out_path, lines)
    log(f"输出 JSON：{out_path}（{len(lines)} 行，词级时间戳：{split_note}）")

    plot_path = resolve_plot_path(args, out_path, has_audio=pcm is not None)
    if plot_path is not None and pcm is not None:
        subtitle = (
            f"来源：{lrc_path.name}｜{len(lines)} 行｜LRC 直读（词级：{split_note}）"
        )
        render_check_plot(pcm, sample_rate, lines, plot_path, "歌词对齐校验（LRC 直读）", subtitle,
                          note=warnings[0] if warnings else None)
        log(f"校验图：{plot_path}")

    print_report(lines, None, warnings)
    return 1 if (args.strict and warnings) else 0


def run_text_mode(args: argparse.Namespace, audio_path: Path, text_path: Path, out_path: Path) -> int:
    log(f"模式 2（纯文本对齐）: 音频 {audio_path} / 歌词 {text_path}")
    texts = load_lyric_lines(text_path)
    log(f"歌词行数：{len(texts)}")

    pcm, sample_rate = decode_audio_mono(audio_path)
    duration_ms = int(pcm.size / sample_rate * 1000)
    log(f"音频时长：{duration_ms / 1000:.2f}s（{sample_rate} Hz）")

    device = resolve_device(args.device)
    compute_type = resolve_compute_type(args.compute_type, device)

    with tempfile.TemporaryDirectory(prefix="align-lyrics-") as tmp:
        if args.no_separate:
            log("跳过 Demucs 人声分离（--no-separate）")
            transcribe_path = audio_path
        else:
            transcribe_path = separate_vocals(
                audio_path, Path(tmp), args.separation_model, device
            )
            log(f"人声轨：{transcribe_path.name}")

        trim_ms = 0
        asr_input = transcribe_path
        if not args.no_trim:
            stem_pcm, stem_sr = decode_audio_mono(transcribe_path)
            trim_ms = detect_lead_silence_ms(stem_pcm, stem_sr)
            if trim_ms > 0:
                try:
                    asr_input = prepare_asr_audio(transcribe_path, Path(tmp), trim_ms)
                    log(f"检测到前导静音 {trim_ms / 1000:.2f}s：已裁掉并在时间戳上加回")
                except AlignError as exc:
                    log(f"警告：{exc}（改用原始音频，首词时间可能偏早）")
                    trim_ms = 0
                    asr_input = transcribe_path

        asr_words = transcribe_words(
            asr_input,
            model_name=args.model,
            device=device,
            compute_type=compute_type,
            language=args.language,
            vad=args.vad,
            model_dir=Path(args.model_dir) if args.model_dir else None,
            offset_ms=trim_ms,
        )

    lines, stats = align_lyrics(texts, asr_words, duration_ms)
    warnings = validate(lines, duration_ms, expected_lines=len(texts))
    write_json(out_path, lines)
    log(f"输出 JSON：{out_path}（{len(lines)} 行，{stats.total_tokens} 词）")

    plot_path = resolve_plot_path(args, out_path, has_audio=True)
    if plot_path is not None:
        subtitle = (
            f"来源：{audio_path.name}｜{len(texts)} 行 / {stats.total_tokens} 词"
            f"｜词命中 {stats.coverage * 100:.1f}%"
            f"｜{'无分离' if args.no_separate else 'Demucs ' + args.separation_model}"
            f" + faster-whisper {args.model}"
            + (f"｜裁前导静音 {trim_ms / 1000:.2f}s" if trim_ms else "")
        )
        render_check_plot(pcm, sample_rate, lines, plot_path, "歌词对齐校验（纯文本对齐）", subtitle,
                          note=warnings[0] if warnings else None)
        log(f"校验图：{plot_path}")

    print_report(lines, stats, warnings)
    return 1 if (args.strict and warnings) else 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    out_path = Path(args.out)

    try:
        if args.lrc:
            if args.text:
                parser.error("--lrc 与 --text 不能同时使用（LRC 模式不需要歌词文本）")
            return run_lrc_mode(args, Path(args.lrc), out_path)
        if args.audio and args.text:
            if args.split_words:
                parser.error(
                    "--split-words 仅用于 LRC 模式：纯文本模式的词级时间戳来自真实对齐，无需推导"
                )
            return run_text_mode(args, Path(args.audio), Path(args.text), out_path)
    except AlignError as exc:
        print(f"[align-lyrics] 错误：{exc}", file=sys.stderr)
        return 2

    parser.error("请指定模式：--lrc <file>，或 --audio <file> --text <file>")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
