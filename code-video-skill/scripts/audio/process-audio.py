#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按需音频加工：淡入淡出 / 响度标准化（只在用户明确要求时执行）。

边界：
  * 本项目默认**不做**任何音频加工——不做闪避、不做重混、不改动用户音乐本体；
  * 本工具只服务"用户明确要求"的场景：淡入 / 淡出（`afade`）与响度标准化（`loudnorm`）；
  * 必须显式传 `--fade-in` / `--fade-out` / `--loudnorm` 才执行对应操作；
    一个都没传时脚本什么都不做，直接报错并列出可用参数。
  * 加工必然重新编码音频（有损格式会再损失一代），执行前会在终端提示。

处理顺序：先响度标准化（两遍 loudnorm，线性增益），再叠加淡入淡出。
淡入淡出放在最后，形状才是精确的；响度测量也只针对未淡化的节目本体。

退出码：0 = 成功；1 = 失败（参数 / 环境 / ffmpeg 错误）；2 = 已产出文件但响度自检超容差。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ffmpeg_locate import FfmpegNotFound, FfmpegTools, locate_pair

TOOL = "scripts/audio/process-audio.py"

DEFAULT_TARGET_LUFS = -14.0
DEFAULT_TRUE_PEAK = -1.5
DEFAULT_LRA = 11.0
DEFAULT_BITRATE = "192k"
DEFAULT_TOLERANCE_LU = 0.5

# loudnorm 的可调范围（ffmpeg 滤镜文档）
LUFS_RANGE = (-70.0, -5.0)
TP_RANGE = (-9.0, 0.0)
LRA_RANGE = (1.0, 50.0)

# 常见容器 → 编码器；未列出时交给 ffmpeg 按扩展名决定
CODEC_BY_SUFFIX = {
    ".wav": ["pcm_s16le"],
    ".flac": ["flac"],
    ".aif": ["pcm_s16be"],
    ".aiff": ["pcm_s16be"],
    ".mp3": ["libmp3lame"],
    ".m4a": ["aac"],
    ".mp4": ["aac"],
    ".aac": ["aac"],
    ".ogg": ["libvorbis"],
    ".oga": ["libvorbis"],
    ".opus": ["libopus"],
}
LOSSLESS_SUFFIX = {".wav", ".flac", ".aif", ".aiff"}

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_WARN = 2


class ProcessError(RuntimeError):
    """可直接展示给用户的错误。"""


@dataclass(frozen=True)
class LoudnormRequest:
    target_lufs: float
    true_peak: float
    lra: float

    def filter_prefix(self) -> str:
        return (
            f"loudnorm=I={self.target_lufs:g}:TP={self.true_peak:g}:LRA={self.lra:g}"
        )


def setup_stdio() -> None:
    """管道/重定向场景下固定 UTF-8 输出，避免系统区域编码导致中文乱码或报错。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            if getattr(stream, "isatty", lambda: False)():
                reconfigure(errors="replace")
            else:
                reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="process-audio.py",
        description=(
            "按需音频加工：淡入 / 淡出 / 响度标准化。\n"
            "本项目默认不做音频加工，本工具只在用户明确要求时使用。"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            "示例：\n"
            "  python process-audio.py -i 音乐.wav -o out/音乐-淡入淡出.wav --fade-in 1.5 --fade-out 2\n"
            "  python process-audio.py -i 音乐.wav -o out/音乐-norm.m4a --loudnorm            # 默认 -14 LUFS\n"
            "  python process-audio.py -i 音乐.wav -o out/音乐-norm.m4a --loudnorm -12 --report out/process.json\n"
            "\n"
            "边界说明：\n"
            "  * 不传 --fade-in / --fade-out / --loudnorm 时脚本什么都不做并直接报错——\n"
            "    \"不做音频加工\"是本项目的默认策略，加工必须是用户明确要求；\n"
            "  * 加工会重新编码音频（有损格式会再损失一代），并且会改变听感，请先与用户确认；\n"
            "  * 淡入淡出用 ffmpeg afade，响度用两遍 loudnorm（线性增益）：先标准化、后淡化。\n"
            "\n"
            "退出码：0 = 成功；1 = 失败（参数 / 环境 / ffmpeg 错误）；2 = 已产出但响度自检超容差。\n"
        ),
    )
    parser.add_argument("-i", "--input", required=True, help="输入音频文件路径")
    parser.add_argument("-o", "--output", required=True, help="输出音频文件路径（扩展名决定编码格式）")
    parser.add_argument("--fade-in", type=float, default=None, metavar="SECONDS", help="淡入时长（秒，默认不做）")
    parser.add_argument("--fade-out", type=float, default=None, metavar="SECONDS", help="淡出时长（秒，默认不做）")
    parser.add_argument(
        "--loudnorm",
        type=float,
        nargs="?",
        const=DEFAULT_TARGET_LUFS,
        default=None,
        metavar="LUFS",
        help=f"响度标准化目标（默认不做；只写 --loudnorm 时目标为 {DEFAULT_TARGET_LUFS:g} LUFS）",
    )
    parser.add_argument(
        "--true-peak",
        type=float,
        default=DEFAULT_TRUE_PEAK,
        metavar="DBTP",
        help=f"响度标准化时的真峰上限（默认 {DEFAULT_TRUE_PEAK:g}）",
    )
    parser.add_argument(
        "--lra",
        type=float,
        default=DEFAULT_LRA,
        metavar="LU",
        help=f"响度标准化时的响度范围目标（默认 {DEFAULT_LRA:g}）",
    )
    parser.add_argument("--bitrate", default=DEFAULT_BITRATE, help=f"有损输出的码率（默认 {DEFAULT_BITRATE}）")
    parser.add_argument(
        "--tolerance-lu",
        type=float,
        default=DEFAULT_TOLERANCE_LU,
        metavar="LU",
        help=f"响度自检容差（默认 {DEFAULT_TOLERANCE_LU:g} LU，超出返回退出码 2）",
    )
    parser.add_argument("--report", default=None, metavar="PATH", help="把加工记录（含 ffmpeg 命令与实测值）写成 JSON")
    parser.add_argument("--overwrite", action="store_true", help="允许覆盖已存在的输出文件")
    parser.add_argument("--ffmpeg", default=None, metavar="PATH", help="手动指定 ffmpeg 可执行文件")
    parser.add_argument("--ffprobe", default=None, metavar="PATH", help="手动指定 ffprobe 可执行文件")
    return parser


def run_ffmpeg(cmd: list[str], purpose: str) -> subprocess.CompletedProcess[str]:
    """执行 ffmpeg/ffprobe，失败时抛出带 stderr 尾巴的可读错误。"""
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3600,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ProcessError(f"{purpose}失败：无法执行 {cmd[0]}\n{exc}") from exc
    if proc.returncode != 0:
        tail = [line for line in (proc.stderr or "").strip().splitlines() if line.strip()][-4:]
        raise ProcessError(
            f"{purpose}失败（ffmpeg 退出码 {proc.returncode}）：\n" + "\n".join(f"  {line}" for line in tail)
        )
    return proc


def parse_loudnorm_json(stderr: str) -> dict[str, Any]:
    """从 loudnorm print_format=json 的日志里取最后一个 JSON 块。"""
    blocks = re.findall(r"\{[^{}]*\}", stderr or "")
    for block in reversed(blocks):
        if "input_i" not in block:
            continue
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        if "input_i" in data:
            return data
    raise ProcessError(
        "无法从 ffmpeg 输出里解析 loudnorm 测量结果（loudnorm 未返回 JSON）：\n"
        + "\n".join(f"  {line}" for line in (stderr or "").strip().splitlines()[-4:])
    )


def measure_loudness(
    tools: FfmpegTools, path: Path, request: LoudnormRequest
) -> tuple[dict[str, Any], list[str]]:
    """对任意音频文件跑一遍 loudnorm 测量（pass 1），返回 (测量 JSON, 实际命令)。"""
    cmd = [
        str(tools.ffmpeg),
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-af",
        f"{request.filter_prefix()}:print_format=json",
        "-f",
        "null",
        "-",
    ]
    return parse_loudnorm_json(run_ffmpeg(cmd, f"响度测量（{path.name}）").stderr), cmd


def linear_feasibility(measured: dict[str, Any], request: LoudnormRequest) -> dict[str, Any]:
    """预判"线性增益能否同时满足目标响度与真峰上限"。

    线性模式下输出真峰 ≈ 输入真峰 + 增益，因此需要 峰均比 ≤ (真峰上限 − 目标响度)；
    不满足时 loudnorm 会退回动态模式（压缩动态范围）并且达不到目标响度——提前说清楚，
    比处理完再解释有用。
    """
    input_i = _finite(measured.get("input_i"))
    input_tp = _finite(measured.get("input_tp"))
    if input_i is None or input_tp is None:
        return {"linear_feasible": None}
    gain = request.target_lufs - input_i
    peak_loudness_ratio = input_tp - input_i
    return {
        "linear_feasible": bool(peak_loudness_ratio <= request.true_peak - request.target_lufs + 1e-6),
        "gain_db": round(gain, 2),
        "peak_loudness_ratio_lu": round(peak_loudness_ratio, 2),
        "projected_true_peak_dbtp": round(input_tp + gain, 2),
    }


def probe_audio(tools: FfmpegTools, path: Path) -> dict[str, Any]:
    """读取音频流信息：时长 / 采样率 / 声道 / 编码。"""
    cmd = [
        str(tools.ffprobe),
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,duration",
        "-show_entries",
        "format=duration,format_name",
        "-of",
        "json",
        str(path),
    ]
    try:
        payload = json.loads(run_ffmpeg(cmd, f"读取音频信息（{path.name}）").stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ProcessError(f"ffprobe 输出不是合法 JSON：{exc}") from exc

    streams = payload.get("streams") or []
    if not streams:
        raise ProcessError(f"{path.name} 里没有音频流，无法加工")
    stream = streams[0]
    duration = _first_number(stream.get("duration"), (payload.get("format") or {}).get("duration"))
    if duration is None or duration <= 0:
        raise ProcessError(f"无法确定 {path.name} 的时长（ffprobe 未给出 duration）")
    return {
        "duration": duration,
        "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else None,
        "channels": int(stream["channels"]) if stream.get("channels") else None,
        "codec": stream.get("codec_name"),
        "format": (payload.get("format") or {}).get("format_name"),
    }


def window_rms_db(tools: FfmpegTools, path: Path, start: float, seconds: float) -> float | None:
    """量取某段窗口的 RMS（dBFS），用于淡入淡出的旁证记录。"""
    cmd = [
        str(tools.ffmpeg),
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-v",
        "error",
        "-ss",
        f"{start:.6f}",
        "-t",
        f"{seconds:.6f}",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-af",
        "astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600
    )
    if proc.returncode != 0:
        return None
    # ametadata 每帧打印一行"滚动 RMS"，取最后一行才是整段窗口的总 RMS
    matches = re.findall(r"lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-?inf)", proc.stdout or "")
    if not matches:
        return None
    try:
        return float(matches[-1])
    except ValueError:
        return None


def _first_number(*values: Any) -> float | None:
    for value in values:
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _finite(value: Any) -> float | None:
    number = _first_number(value)
    if number is None:
        return None
    return number if number == number and abs(number) != float("inf") else None


def _format_db(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f}"


def build_filter_chain(
    loudnorm: LoudnormRequest | None,
    measured: dict[str, Any] | None,
    fade_in: float | None,
    fade_out: float | None,
    duration: float,
) -> str:
    """拼滤镜链：loudnorm（两遍的第二遍）→ afade in → afade out。"""
    parts: list[str] = []
    if loudnorm is not None:
        normalized = loudnorm.filter_prefix()
        if measured:
            keys = {
                "measured_I": "input_i",
                "measured_TP": "input_tp",
                "measured_LRA": "input_lra",
                "measured_thresh": "input_thresh",
                "offset": "target_offset",
            }
            values = {key: _finite(measured.get(field)) for key, field in keys.items()}
            if all(value is not None for value in values.values()):
                normalized += "".join(f":{key}={value:g}" for key, value in values.items())
                normalized += ":linear=true"
        normalized += ":print_format=json"
        parts.append(normalized)
    if fade_in is not None:
        parts.append(f"afade=t=in:st=0:d={fade_in:g}")
    if fade_out is not None:
        parts.append(f"afade=t=out:st={max(duration - fade_out, 0.0):.6f}:d={fade_out:g}")
    return ",".join(parts)


def codec_args(output: Path, bitrate: str) -> list[str]:
    """按输出扩展名给出编码参数；未知扩展名交给 ffmpeg 自行决定。"""
    codec = CODEC_BY_SUFFIX.get(output.suffix.lower())
    if not codec:
        return []
    args = ["-c:a", *codec]
    if output.suffix.lower() not in LOSSLESS_SUFFIX:
        args += ["-b:a", bitrate]
    return args


def validate_requests(args: argparse.Namespace) -> tuple[LoudnormRequest | None, float | None, float | None]:
    """校验参数并返回 (loudnorm, fade_in, fade_out)；没有任何操作时直接报错。"""
    fade_in = args.fade_in
    fade_out = args.fade_out
    for name, value in (("--fade-in", fade_in), ("--fade-out", fade_out)):
        if value is not None and value <= 0:
            raise ProcessError(f"{name} 必须为正数（秒），当前为 {value:g}")

    loudnorm = None
    if args.loudnorm is not None:
        if not LUFS_RANGE[0] <= args.loudnorm <= LUFS_RANGE[1]:
            raise ProcessError(
                f"--loudnorm 目标 {args.loudnorm:g} 超出 loudnorm 支持范围 "
                f"{LUFS_RANGE[0]:g} ~ {LUFS_RANGE[1]:g} LUFS"
            )
        if not TP_RANGE[0] <= args.true_peak <= TP_RANGE[1]:
            raise ProcessError(
                f"--true-peak {args.true_peak:g} 超出 loudnorm 支持范围 {TP_RANGE[0]:g} ~ {TP_RANGE[1]:g} dBTP"
            )
        if not LRA_RANGE[0] <= args.lra <= LRA_RANGE[1]:
            raise ProcessError(
                f"--lra {args.lra:g} 超出 loudnorm 支持范围 {LRA_RANGE[0]:g} ~ {LRA_RANGE[1]:g} LU"
            )
        loudnorm = LoudnormRequest(target_lufs=args.loudnorm, true_peak=args.true_peak, lra=args.lra)

    if loudnorm is None and fade_in is None and fade_out is None:
        raise ProcessError(
            "未指定任何加工操作：本项目默认不做音频加工，本工具也不做隐式加工。\n"
            "  如果用户确实要求了加工，请显式传参：\n"
            "    --fade-in 1.5          淡入（秒）\n"
            "    --fade-out 2           淡出（秒）\n"
            "    --loudnorm             响度标准化（默认 -14 LUFS，可写 --loudnorm -12）"
        )
    return loudnorm, fade_in, fade_out


def check_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    input_path = Path(args.input).expanduser()
    output_path = Path(args.output).expanduser()
    if not input_path.is_file():
        raise ProcessError(f"输入文件不存在：{input_path}")
    try:
        same = os.path.normcase(str(input_path.resolve())) == os.path.normcase(str(output_path.resolve()))
    except OSError:
        same = os.path.normcase(str(input_path.absolute())) == os.path.normcase(str(output_path.absolute()))
    if same:
        raise ProcessError(f"输出路径不能与输入相同（本工具不做原地加工）：{output_path}")
    if output_path.exists() and not args.overwrite:
        raise ProcessError(f"输出文件已存在：{output_path}（需要覆盖请显式加 --overwrite）")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    return input_path, output_path


def process(args: argparse.Namespace) -> int:
    loudnorm, fade_in, fade_out = validate_requests(args)
    input_path, output_path = check_paths(args)

    try:
        tools = locate_pair(args.ffmpeg, args.ffprobe)
    except FfmpegNotFound as exc:
        raise ProcessError(str(exc)) from exc

    info = probe_audio(tools, input_path)
    duration = info["duration"]
    total_fade = (fade_in or 0.0) + (fade_out or 0.0)
    if total_fade > duration:
        raise ProcessError(
            f"淡入 {fade_in or 0:g} s + 淡出 {fade_out or 0:g} s = {total_fade:g} s "
            f"超过音频时长 {duration:.3f} s，无法加工"
        )

    measured: dict[str, Any] | None = None
    pass1_cmd: list[str] | None = None
    feasibility: dict[str, Any] | None = None
    if loudnorm:
        measured, pass1_cmd = measure_loudness(tools, input_path, loudnorm)
        feasibility = linear_feasibility(measured, loudnorm)
    chain = build_filter_chain(loudnorm, measured, fade_in, fade_out, duration)

    pass2_cmd = [
        str(tools.ffmpeg), "-hide_banner", "-nostdin", "-nostats", "-y", "-i", str(input_path),
        "-map", "0:a:0", "-af", chain, *codec_args(output_path, args.bitrate), str(output_path),
    ]
    print("提示      ：加工会重新编码音频；本项目默认不做音频加工，本次操作由显式参数触发")
    if feasibility and feasibility.get("linear_feasible") is False:
        print(f"预判      ：线性增益不可行（素材峰均比 {feasibility['peak_loudness_ratio_lu']:g} LU > "
              f"目标允许的 {loudnorm.true_peak - loudnorm.target_lufs:g} LU）——"
              "loudnorm 将回退动态模式，实际响度会低于目标，详见结尾告警")
    proc = run_ffmpeg(pass2_cmd, f"加工 {input_path.name}")

    summary = parse_loudnorm_json(proc.stderr) if loudnorm else None
    output_info = probe_audio(tools, output_path)

    checks: dict[str, Any] = {}
    warnings: list[str] = []
    duration_delta = abs(output_info["duration"] - duration)
    checks["duration_preserved"] = duration_delta <= 0.1
    if not checks["duration_preserved"]:
        warnings.append(
            f"输出时长 {output_info['duration']:.3f} s 与输入 {duration:.3f} s 相差 {duration_delta * 1000:.0f} ms"
        )

    if loudnorm:
        achieved_json, _ = measure_loudness(tools, output_path, loudnorm)
        achieved = _finite(achieved_json.get("input_i"))
        delta = None if achieved is None else achieved - loudnorm.target_lufs
        normalization_type = str((summary or {}).get("normalization_type", "")).lower()
        checks["loudness_measured_lufs"] = achieved
        checks["loudness_delta_lu"] = round(delta, 3) if delta is not None else None
        checks["loudness_within_tolerance"] = bool(delta is not None and abs(delta) <= args.tolerance_lu)
        checks["loudnorm_mode"] = normalization_type or None
        if achieved is None:
            warnings.append("无法测量输出响度（loudnorm 未返回可用数值），请人工确认")
        elif not checks["loudness_within_tolerance"]:
            message = (
                f"响度自检超出容差：输出实测 {achieved:.2f} LUFS，目标 {loudnorm.target_lufs:g} LUFS"
                f"（偏差 {delta:+.2f} LU，容差 ±{args.tolerance_lu:g} LU）"
            )
            if normalization_type and normalization_type != "linear":
                allowed = loudnorm.true_peak - loudnorm.target_lufs
                message += (
                    f"\n  原因：loudnorm 使用 {normalization_type} 模式——素材峰均比 "
                    f"{(feasibility or {}).get('peak_loudness_ratio_lu', 'n/a')} LU，"
                    f"高于目标组合允许的 {allowed:g} LU，无法在真峰 {loudnorm.true_peak:g} dBTP 内线性达标。"
                    "\n  可选处理：放宽 --true-peak（例如 -1.0）、降低目标响度，或先对素材限幅后再标准化。"
                )
            warnings.append(message)

    fade_windows: dict[str, Any] = {}
    if fade_in is not None:
        window = min(fade_in, duration)
        fade_windows["head"] = {
            "seconds": window,
            "input_rms_dbfs": window_rms_db(tools, input_path, 0.0, window),
            "output_rms_dbfs": window_rms_db(tools, output_path, 0.0, window),
        }
    if fade_out is not None:
        window = min(fade_out, duration)
        fade_windows["tail"] = {
            "seconds": window,
            "input_rms_dbfs": window_rms_db(tools, input_path, max(duration - window, 0.0), window),
            "output_rms_dbfs": window_rms_db(tools, output_path, max(duration - window, 0.0), window),
        }

    report = {
        "tool": TOOL,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "input": {"file": input_path.name, **info},
        "output": {
            "file": output_path.name,
            "size_bytes": output_path.stat().st_size,
            **output_info,
            "bitrate": None if output_path.suffix.lower() in LOSSLESS_SUFFIX else args.bitrate,
        },
        "operations": {
            "fade_in_seconds": fade_in,
            "fade_out_seconds": fade_out,
            "loudnorm": None
            if loudnorm is None
            else {
                "target_lufs": loudnorm.target_lufs,
                "true_peak_dbtp": loudnorm.true_peak,
                "lra_lu": loudnorm.lra,
            },
            "order": "响度标准化 → 淡入/淡出",
        },
        "loudnorm": None
        if loudnorm is None
        else {"pass1_input": measured, "feasibility": feasibility, "pass2_output": summary},
        "fade_windows": fade_windows,
        "checks": checks,
        "warnings": warnings,
        "ffmpeg": {
            "version": tools.version,
            "path": str(tools.ffmpeg),
            "source": tools.ffmpeg_source,
            "commands": {"measure": pass1_cmd, "apply": pass2_cmd},
        },
    }

    if args.report:
        report_path = Path(args.report).expanduser()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"输入      ：{input_path}（{duration:.3f} s，{info['sample_rate']} Hz，"
          f"{info['channels']} 声道，{info['codec']}）")
    print(f"输出      ：{output_path}（{output_info['duration']:.3f} s，{output_info['codec']}，"
          f"{output_path.stat().st_size / 1024:.0f} KiB）")
    print(f"ffmpeg    ：{tools.version}（{tools.ffmpeg_source}）")
    operations = []
    if fade_in is not None:
        operations.append(f"淡入 {fade_in:g} s")
    if fade_out is not None:
        operations.append(f"淡出 {fade_out:g} s")
    if loudnorm is not None:
        operations.append(
            f"响度标准化 {loudnorm.target_lufs:g} LUFS（TP {loudnorm.true_peak:g} dBTP，LRA {loudnorm.lra:g}）"
        )
    print(f"操作      ：{'；'.join(operations)}")
    if loudnorm is not None and summary:
        print(f"loudnorm  ：输出 summary {summary.get('output_i')} LUFS / 真峰 {summary.get('output_tp')} dBTP"
              f"（{summary.get('normalization_type')}）")
    if checks.get("loudness_measured_lufs") is not None:
        print(f"响度自检  ：输出实测 {checks['loudness_measured_lufs']:.2f} LUFS，"
              f"偏差 {checks['loudness_delta_lu']:+.2f} LU（容差 ±{args.tolerance_lu:g}）")
    for name, label in (("head", "淡入窗口"), ("tail", "淡出窗口")):
        metrics = fade_windows.get(name)
        if metrics:
            position = "首" if name == "head" else "末"
            print(f"{label}  ：{position} {metrics['seconds']:g} s RMS "
                  f"{_format_db(metrics['input_rms_dbfs'])} → {_format_db(metrics['output_rms_dbfs'])} dBFS")
    for warning in warnings:
        print(f"警告      ：{warning.replace(chr(10), chr(10) + '          ')}")
    if args.report:
        print(f"加工记录  ：{Path(args.report).expanduser()}")
    print(f"自检      ：{'通过' if not warnings else '有告警'}")

    return EXIT_WARN if warnings else EXIT_OK


def main(argv: list[str] | None = None) -> int:
    setup_stdio()
    args = build_parser().parse_args(argv)
    try:
        return process(args)
    except ProcessError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_ERROR
    except KeyboardInterrupt:
        print("已取消", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
