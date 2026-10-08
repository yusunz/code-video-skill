#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ffmpeg / ffprobe 定位：标准 PATH 查找；找不到时报出可操作的指引。

设计边界（环境适配边界）：
  * 只依赖标准环境——ffmpeg / ffprobe 需在 PATH 中可用（完整版构建，两者成对）；
  * 不为特定用户的本机配置写适配：不扫描注册表、不展开 PATH 中的变量引用形式；
  * 环境问题（PATH 未配置、变量未展开等）由用户侧解决，本模块只负责"报错 + 指引"；
  * 探测命令为 `<tool> -version`，无副作用；定位结果进程内缓存。
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


class FfmpegNotFound(RuntimeError):
    """找不到可用的 ffmpeg / ffprobe。"""


@dataclass(frozen=True)
class FfmpegTools:
    """一次定位得到的工具对与来源信息。"""

    ffmpeg: Path
    ffprobe: Path
    version: str
    ffmpeg_source: str
    ffprobe_source: str

    def describe(self) -> str:
        return f"{self.version}\n  ffmpeg：{self.ffmpeg}（{self.ffmpeg_source}）\n  ffprobe：{self.ffprobe}（{self.ffprobe_source}）"


@lru_cache(maxsize=None)
def probe_version(executable: str) -> str | None:
    """跑一次 `<tool> -version` 确认可用，返回首行版本信息；失败返回 None。"""
    try:
        proc = subprocess.run(
            [executable, "-version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    first_line = (proc.stdout or proc.stderr or "").strip().splitlines()
    return first_line[0].strip() if first_line else executable


def _resolve(base: str, override: str | None, attempts: list[str]) -> Path | None:
    """按 命令行指定 → PATH（按名字解析）的顺序找一个可执行文件。"""
    if override:
        path = Path(override).expanduser()
        if path.is_file() and probe_version(str(path)):
            return path
        attempts.append(f"命令行指定的 {base}：{path}（不存在或无法执行）")

    by_name = shutil.which(base)
    if by_name and probe_version(by_name):
        return Path(by_name)

    attempts.append(f"PATH 中找不到可用的 {base}")
    return None


_FIX_HINTS = (
    "处理办法：\n"
    "  1) 安装完整版 ffmpeg 并确保 bin 目录在 PATH 中（新开的终端需能看到 `ffmpeg -version`；"
    "质检依赖 libx264 / loudnorm / silencedetect / framemd5 等）；\n"
    "  2) 或运行本工具时用 --ffmpeg / --ffprobe 指定可执行文件路径。"
)


def locate_pair(ffmpeg_override: str | None = None, ffprobe_override: str | None = None) -> FfmpegTools:
    """定位 ffmpeg + ffprobe；任一缺失即抛 FfmpegNotFound（消息含尝试记录与指引）。"""
    attempts: list[str] = []
    ffmpeg = _resolve("ffmpeg", ffmpeg_override, attempts)
    ffprobe = _resolve("ffprobe", ffprobe_override, attempts)
    if ffmpeg and ffprobe:
        version = probe_version(str(ffmpeg)) or "未知版本"
        return FfmpegTools(
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
            version=version,
            ffmpeg_source="命令行指定" if ffmpeg_override else "PATH",
            ffprobe_source="命令行指定" if ffprobe_override else "PATH",
        )

    if ffmpeg and not ffprobe:
        attempts.append("ffmpeg 可用，但 ffprobe 找不到（两者需来自同一份完整版构建）")
    raise FfmpegNotFound(
        "找不到可用的 ffmpeg / ffprobe（两者必须成对）。\n"
        + "\n".join(f"  · {line}" for line in dict.fromkeys(attempts))
        + "\n"
        + _FIX_HINTS
    )


def find_ffmpeg(override: str | None = None) -> Path:
    """只找 ffmpeg（analyze-music.py 的 m4a 解码回退用）。"""
    attempts: list[str] = []
    found = _resolve("ffmpeg", override, attempts)
    if found:
        return found
    raise FfmpegNotFound("找不到可用的 ffmpeg。\n" + "\n".join(f"  · {line}" for line in attempts) + "\n" + _FIX_HINTS)
