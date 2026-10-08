#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""音乐离线分析：BPM / 拍点 / downbeats / onset / 能量包络 → JSON + 校验图。

定位：
  * 把音乐一次性解析成静态 JSON，Remotion 逐帧读取，不做实时分析；
  * downbeats 采用 4/4 假设（beats[::4]，第 1 拍视为强拍），不是模型检测结果；
  * 同时输出 PNG 校验图（波形 + 拍点线 + BPM 标注），供人"看一眼"自检。

边界：只做分析，不改动音频文件。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import librosa
import numpy as np

from ffmpeg_locate import FfmpegNotFound, find_ffmpeg

TOOL = "scripts/audio/analyze-music.py"

# 分析参数：hop_length 同时决定 onset 强度与拍点的时间分辨率基准。
# 128 帧 @22.05 kHz ≈ 5.8 ms/帧——512 帧的粗网格会把 120 BPM 的拍点量化到 117.5（实测），
# 更细的网格把量化误差压到 0.1% 量级（实测 120.19 BPM / 中位间隔 0.4992 s）。
DEFAULT_HOP_LENGTH = 128
# onset 分析的 STFT 窗长：窗越长频率分辨率越高、起音定位越钝（低频尤其明显）。
# 实测（合成素材、hop=128、修正后的中段偏差）2048 → 1024 可把偏差从 9.3/14.2 ms 收到 6.2/10.3 ms（click/小曲）。
DEFAULT_N_FFT = 1024
RMS_FRAME_LENGTH = 2048
DEFAULT_SR = 22050
DEFAULT_LEVELS_FPS = 30.0

# 拍点对齐修正：检测器的拍点存在系统滞后（默认参数下实测 +9.6~12.3 ms），
# 用 onset 包络峰值估计一个全局平移量修正，限制幅度避免噪声驱动的漂移。
BEAT_REFINE_WINDOW_FRAMES = 4
BEAT_REFINE_MAX_SHIFT_SECONDS = 0.035

TIME_PRECISION = 6
LEVEL_PRECISION = 4


class AnalyzeError(RuntimeError):
    """可直接展示给用户的错误。"""


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
        prog="analyze-music.py",
        description="音乐离线分析：BPM、拍点、downbeats（4/4 假设）、onset、能量包络 → JSON + PNG 校验图。",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            "示例：\n"
            "  python analyze-music.py 音乐.mp3\n"
            "  python analyze-music.py 音乐.m4a -o out/audio-analysis.json --levels-fps 30\n"
            "\n"
            "说明：\n"
            "  * downbeats = beats[::4]，即 4/4 假设下的强拍，非检测结果；\n"
            "  * levels 为逐帧 RMS，按整段峰值归一化到 0-1，第 i 点对应 t = i / levels_fps；\n"
            "  * 拍点默认做一次有界的 onset 峰值对齐修正（全局平移，见 README 实测），可用 --no-beat-refine 关闭；\n"
            "  * m4a/aac 等容器格式自动改用 ffmpeg 解码（需 PATH 中可用的 ffmpeg）。\n"
        ),
    )
    parser.add_argument("audio", help="输入音频文件路径（mp3 / wav / m4a / flac / ogg 等）")
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="输出 JSON 路径（默认：音频同目录下的 audio-analysis.json）",
    )
    parser.add_argument(
        "--plot",
        default=None,
        help="校验图 PNG 路径（默认：与 JSON 同名的 .png）",
    )
    parser.add_argument(
        "--no-plot",
        action="store_true",
        help="跳过校验图输出（默认输出，供人工自检）",
    )
    parser.add_argument(
        "--levels-fps",
        type=float,
        default=DEFAULT_LEVELS_FPS,
        help=f"能量包络采样率，单位 点/秒（默认 {DEFAULT_LEVELS_FPS:g}，建议与视频 fps 一致）",
    )
    parser.add_argument(
        "--hop-length",
        type=int,
        default=DEFAULT_HOP_LENGTH,
        help=f"分析帧移（采样点，默认 {DEFAULT_HOP_LENGTH}；越小拍点越精细、耗时越高）",
    )
    parser.add_argument(
        "--n-fft",
        type=int,
        default=DEFAULT_N_FFT,
        help=f"onset 分析窗长（采样点，默认 {DEFAULT_N_FFT}；越大频率分辨率越高、起音定位越钝）",
    )
    parser.add_argument(
        "--no-beat-refine",
        action="store_true",
        help="关闭拍点的 onset 峰值对齐修正（默认开启，见 README 的实测说明）",
    )
    parser.add_argument(
        "--sr",
        type=int,
        default=DEFAULT_SR,
        help=f"分析用采样率，仅影响分析精度与速度，不改变原文件（默认 {DEFAULT_SR}）",
    )
    return parser


def load_audio(path: Path, sr: int) -> tuple[np.ndarray, int, str]:
    """读取音频为单声道 float 波形；soundfile 不支持时回退 ffmpeg。"""
    try:
        y, sr_out = librosa.load(str(path), sr=sr, mono=True)
        return y, int(sr_out), "librosa/soundfile"
    except Exception as soundfile_error:  # noqa: BLE001 - 需要兜底任意解码异常
        first_error = soundfile_error

    try:
        ffmpeg = find_ffmpeg()
    except FfmpegNotFound as locate_error:
        raise AnalyzeError(
            f"无法解码音频 {path.name}：{first_error}\n"
            f"{locate_error}"
        ) from first_error

    with tempfile.TemporaryDirectory(prefix="analyze-music-") as tmp_dir:
        wav_path = Path(tmp_dir) / "decoded.wav"
        cmd = [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(path),
            "-vn",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            detail = (proc.stderr or "").strip().splitlines()
            message = detail[-1] if detail else "ffmpeg 未输出错误详情"
            raise AnalyzeError(f"ffmpeg 解码失败：{path}\n{message}")
        y, sr_out = librosa.load(str(wav_path), sr=sr, mono=True)
    return y, int(sr_out), "ffmpeg"


def refine_beats_to_onset_peaks(
    beat_times: np.ndarray,
    onset_envelope: np.ndarray,
    hop_length: int,
    sr: int,
) -> tuple[np.ndarray, float]:
    """把整条拍点网格对齐到 onset 强度峰值，修正检测器的系统滞后。

    每个拍点在 ±BEAT_REFINE_WINDOW_FRAMES 帧内找包络峰值（抛物线插值取亚帧精度），
    取全部偏移量的中位数作为全局平移量——只做整体平移，不改变网格的均匀性。
    """
    if beat_times.size == 0 or onset_envelope.size < 3:
        return beat_times, 0.0

    last = onset_envelope.size - 1
    peak_times = np.empty(beat_times.size, dtype=float)
    for index, beat_time in enumerate(beat_times):
        center = int(round(beat_time * sr / hop_length))
        lo = max(0, center - BEAT_REFINE_WINDOW_FRAMES)
        hi = min(last, center + BEAT_REFINE_WINDOW_FRAMES)
        if hi - lo < 2:
            peak_times[index] = beat_time
            continue
        peak = lo + int(np.argmax(onset_envelope[lo : hi + 1]))
        left = onset_envelope[peak - 1] if peak > 0 else onset_envelope[peak]
        right = onset_envelope[peak + 1] if peak < last else onset_envelope[peak]
        curvature = left - 2.0 * onset_envelope[peak] + right
        offset = float(np.clip(0.5 * (left - right) / curvature, -0.5, 0.5)) if curvature != 0 else 0.0
        peak_times[index] = (peak + offset) * hop_length / sr

    shift = float(np.median(peak_times - beat_times))
    shift = float(np.clip(shift, -BEAT_REFINE_MAX_SHIFT_SECONDS, BEAT_REFINE_MAX_SHIFT_SECONDS))
    return np.clip(beat_times + shift, 0.0, None), shift


def analyze_audio(
    y: np.ndarray,
    sr: int,
    levels_fps: float,
    hop_length: int,
    n_fft: int,
    refine_beats: bool,
) -> dict[str, Any]:
    """核心分析流程，返回 JSON 主体（不含 meta）。"""
    duration = float(librosa.get_duration(y=y, sr=sr))

    onset_envelope = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length, n_fft=n_fft)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_envelope,
        sr=sr,
        hop_length=hop_length,
        trim=False,
    )
    bpm = float(np.atleast_1d(tempo).reshape(-1)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)

    beat_refine_shift = 0.0
    if refine_beats:
        beat_times, beat_refine_shift = refine_beats_to_onset_peaks(
            beat_times, onset_envelope, hop_length, sr
        )

    # backtrack：把 onset 时间回退到能量开始上升处，更接近听感上的起音点
    onset_times = librosa.onset.onset_detect(
        onset_envelope=onset_envelope,
        sr=sr,
        hop_length=hop_length,
        backtrack=True,
        units="time",
    )

    # 能量包络：帧长固定 2048 保证低频能量稳定；hop 决定 levels_fps
    hop = max(1, int(round(sr / levels_fps)))
    rms = librosa.feature.rms(y=y, frame_length=RMS_FRAME_LENGTH, hop_length=hop, center=True)[0]
    peak = float(rms.max()) if rms.size else 0.0
    levels = rms / peak if peak > 0 else np.zeros_like(rms)
    actual_levels_fps = sr / hop

    intervals = np.diff(beat_times)
    beat_interval_median = float(np.median(intervals)) if intervals.size else 0.0
    beat_interval_std = float(np.std(intervals)) if intervals.size else 0.0

    warnings: list[str] = []
    if not 60.0 <= bpm <= 180.0:
        warnings.append(
            f"BPM {bpm:.2f} 落在 60-180 之外：警惕半速/双速误判，请结合校验图人工确认"
        )
    if beat_interval_median > 0 and beat_interval_std / beat_interval_median > 0.15:
        warnings.append(
            f"拍点间隔抖动偏大（std/median = {beat_interval_std / beat_interval_median:.2f}）：曲目可能节奏自由或检测不稳，建议人工标拍"
        )
    beat_count_expected = duration / (60.0 / bpm) if bpm > 0 else 0.0
    if beat_count_expected > 0 and not 0.9 <= len(beat_times) / beat_count_expected <= 1.1:
        warnings.append(
            f"拍点数量异常：实测 {len(beat_times)} 个，按 BPM 推算约 {beat_count_expected:.0f} 个"
        )
    if abs(actual_levels_fps - levels_fps) > 1e-6:
        warnings.append(
            f"levels_fps 由 {levels_fps:g} 吸附为 {actual_levels_fps:.3f}（受采样率与整数 hop 限制）"
        )

    return {
        "bpm": bpm,
        "duration": duration,
        "beats": beat_times,
        "downbeats": beat_times[::4],
        "onsets": onset_times,
        "levels": levels,
        "levels_fps": actual_levels_fps,
        "beat_refine_shift": beat_refine_shift,
        "checks": {
            "bpm_in_60_180": bool(60.0 <= bpm <= 180.0),
            "beat_count_actual": int(len(beat_times)),
            "beat_count_expected": round(beat_count_expected, 2),
            "beat_interval_median": round(beat_interval_median, TIME_PRECISION),
            "beat_interval_std": round(beat_interval_std, TIME_PRECISION),
            "beat_refine_shift_seconds": round(beat_refine_shift, TIME_PRECISION),
            "levels_count_actual": int(levels.size),
            "levels_count_expected": round(duration * actual_levels_fps, 2),
        },
        "warnings": warnings,
    }


def round_sequence(values: np.ndarray, ndigits: int) -> list[float]:
    return [round(float(v), ndigits) for v in np.atleast_1d(values)]


def decimate_waveform(y: np.ndarray, sr: int, target_points: int = 4000) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """把长波形压缩成 min/max 包络，避免 matplotlib 绘制百万级采样点。"""
    n_samples = y.size
    if n_samples <= target_points * 2:
        times = np.arange(n_samples) / sr
        return times, y, y
    step = n_samples // target_points
    usable = step * target_points
    blocks = y[:usable].reshape(target_points, step)
    times = (np.arange(target_points) + 0.5) * step / sr
    return times, blocks.min(axis=1), blocks.max(axis=1)


def pick_cjk_font() -> str | None:
    from matplotlib import font_manager

    available = {font.name for font in font_manager.fontManager.ttflist}
    for name in ("Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC", "DejaVu Sans"):
        if name in available:
            return name
    return None


def render_check_plot(
    png_path: Path,
    y: np.ndarray,
    sr: int,
    analysis: dict[str, Any],
    source_name: str,
) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    font = pick_cjk_font()
    if font is not None:
        plt.rcParams["font.sans-serif"] = [font]
    plt.rcParams["axes.unicode_minus"] = False

    beats = np.asarray(analysis["beats"])
    downbeats = np.asarray(analysis["downbeats"])
    onsets = np.asarray(analysis["onsets"])
    levels = np.asarray(analysis["levels"])
    levels_fps = float(analysis["levels_fps"])
    duration = float(analysis["duration"])
    bpm = float(analysis["bpm"])
    checks = analysis["checks"]

    fig, (ax_wave, ax_zoom, ax_level) = plt.subplots(
        3,
        1,
        figsize=(14, 8),
        dpi=140,
        sharex=False,
        gridspec_kw={"height_ratios": [3, 1.6, 1.2]},
    )

    wave_times, wave_min, wave_max = decimate_waveform(y, sr)
    ax_wave.fill_between(wave_times, wave_min, wave_max, color="#4C78A8", alpha=0.75, linewidth=0)
    ax_wave.vlines(beats, -1.05, 1.05, color="#F58518", alpha=0.55, linewidth=0.7, label=f"拍点（{beats.size}）")
    ax_wave.vlines(
        downbeats,
        -1.05,
        1.05,
        color="#E45756",
        alpha=0.85,
        linewidth=1.4,
        label=f"downbeat（4/4 假设，{downbeats.size}）",
    )
    ax_wave.set_ylim(-1.05, 1.05)
    ax_wave.set_ylabel("振幅")
    ax_wave.legend(loc="upper right", fontsize=8, framealpha=0.9)
    ax_wave.grid(axis="x", alpha=0.25, linewidth=0.6)
    ax_wave.set_xlim(0, max(duration, 1e-3))
    ax_wave.set_title("全曲波形 + 拍点", fontsize=10, loc="left")

    # 前 8 秒放大：波形本身就能看清拍点线是否落在起音上（"看一眼"自检的关键）
    zoom_seconds = min(8.0, max(duration, 1e-3))
    zoom_samples = int(zoom_seconds * sr)
    sample_times = np.arange(zoom_samples) / sr
    ax_zoom.plot(sample_times, y[:zoom_samples], color="#4C78A8", linewidth=0.6)
    ax_zoom.vlines(beats, -1.05, 1.05, color="#F58518", alpha=0.6, linewidth=0.9)
    ax_zoom.vlines(downbeats, -1.05, 1.05, color="#E45756", alpha=0.9, linewidth=1.6)
    ax_zoom.set_xlim(0, zoom_seconds)
    ax_zoom.set_ylim(-1.05, 1.05)
    ax_zoom.set_ylabel("振幅")
    ax_zoom.set_title(f"前 {zoom_seconds:.1f} 秒放大（检验拍点线是否压在起音上）", fontsize=10, loc="left")
    ax_zoom.grid(axis="x", alpha=0.25, linewidth=0.6)

    info = (
        f"BPM {bpm:.2f}\n"
        f"时长 {duration:.3f} s\n"
        f"拍点中位间隔 {checks['beat_interval_median']:.4f} s\n"
        f"拍点对齐修正 {analysis['beat_refine_shift'] * 1000:+.1f} ms\n"
        f"onset {onsets.size} 个 · levels {levels.size} 点 @ {levels_fps:.2f} fps"
    )
    ax_wave.text(
        0.008,
        0.97,
        info,
        transform=ax_wave.transAxes,
        va="top",
        ha="left",
        fontsize=9,
        linespacing=1.5,
        bbox={"boxstyle": "round,pad=0.45", "facecolor": "white", "edgecolor": "#BBBBBB", "alpha": 0.92},
    )
    if analysis["warnings"]:
        ax_wave.text(
            0.008,
            0.03,
            "\n".join(f"警告：{w}" for w in analysis["warnings"]),
            transform=ax_wave.transAxes,
            va="bottom",
            ha="left",
            fontsize=8.5,
            color="#B22222",
            linespacing=1.4,
            bbox={"boxstyle": "round,pad=0.4", "facecolor": "#FFF5F5", "edgecolor": "#E45756", "alpha": 0.95},
        )

    level_times = np.arange(levels.size) / levels_fps
    ax_level.plot(level_times, levels, color="#54A24B", linewidth=0.9)
    if onsets.size:
        ax_level.vlines(onsets, 0.0, 1.05, color="#B279A2", alpha=0.45, linewidth=0.8, label=f"onset（{onsets.size}）")
        ax_level.legend(loc="upper right", fontsize=8, framealpha=0.9)
    ax_level.set_ylim(0.0, 1.05)
    ax_level.set_ylabel("能量 0-1")
    ax_level.set_xlabel("时间（秒）")
    ax_level.grid(axis="x", alpha=0.25, linewidth=0.6)

    ax_level.set_xlim(0, max(duration, 1e-3))
    fig.suptitle(f"{source_name} —— 音乐分析校验图（波形 + 拍点 + BPM）", fontsize=12)
    fig.tight_layout(rect=(0, 0, 1, 0.96))

    png_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(png_path)
    plt.close(fig)


def build_json_payload(
    analysis: dict[str, Any],
    source: Path,
    sr: int,
    loader: str,
    levels_fps_requested: float,
    hop_length: int,
    n_fft: int,
    refine_beats: bool,
) -> dict[str, Any]:
    return {
        "bpm": round(analysis["bpm"], 4),
        "duration": round(analysis["duration"], TIME_PRECISION),
        "beats": round_sequence(analysis["beats"], TIME_PRECISION),
        "downbeats": round_sequence(analysis["downbeats"], TIME_PRECISION),
        "onsets": round_sequence(analysis["onsets"], TIME_PRECISION),
        "levels": round_sequence(analysis["levels"], LEVEL_PRECISION),
        "levels_fps": round(analysis["levels_fps"], 6),
        "meta": {
            "tool": TOOL,
            "source_file": source.name,
            "analyzed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "loader": loader,
            "sample_rate": sr,
            "hop_length": hop_length,
            "n_fft": n_fft,
            "librosa_version": librosa.__version__,
            "time_signature_assumption": "4/4",
            "downbeat_rule": "beats[::4]（4/4 假设：每 4 拍一个强拍，第 1 拍视为强拍；非模型检测结果）",
            "beat_tracking": {
                "method": "librosa.beat.beat_track",
                "start_bpm_prior": 120.0,
                "trim": False,
                "units": "seconds",
            },
            "beat_refinement": {
                "enabled": refine_beats,
                "method": f"onset 包络峰值（±{BEAT_REFINE_WINDOW_FRAMES} 帧内 argmax + 抛物线亚帧插值）的中位数做全局平移",
                "applied_shift_seconds": round(analysis["beat_refine_shift"], TIME_PRECISION),
                "max_shift_seconds": BEAT_REFINE_MAX_SHIFT_SECONDS,
            },
            "onset_method": "librosa.onset.onset_detect（backtrack=True）",
            "levels_definition": "逐帧 RMS（frame_length=2048），按整段峰值归一化到 0-1；第 i 点对应 t = i / levels_fps",
            "levels_fps_requested": levels_fps_requested,
            "checks": analysis["checks"],
            "warnings": analysis["warnings"],
        },
    }


def run(args: argparse.Namespace) -> tuple[Path, Path | None]:
    audio_path = Path(args.audio).expanduser()
    if not audio_path.exists():
        raise AnalyzeError(f"输入文件不存在：{audio_path}")
    if not audio_path.is_file():
        raise AnalyzeError(f"输入路径不是文件：{audio_path}")
    if args.levels_fps <= 0:
        raise AnalyzeError(f"--levels-fps 必须为正数，当前为 {args.levels_fps:g}")
    if args.hop_length <= 0:
        raise AnalyzeError(f"--hop-length 必须为正整数，当前为 {args.hop_length}")
    if args.n_fft <= 0 or args.n_fft % 2 != 0:
        raise AnalyzeError(f"--n-fft 必须为正偶数，当前为 {args.n_fft}")
    if args.sr <= 0:
        raise AnalyzeError(f"--sr 必须为正数，当前为 {args.sr}")
    if args.levels_fps > args.sr:
        raise AnalyzeError(
            f"--levels-fps {args.levels_fps:g} 超过分析采样率 {args.sr} Hz：能量包络每帧至少 1 个采样点"
        )

    json_path = Path(args.output).expanduser() if args.output else audio_path.parent / "audio-analysis.json"
    png_path = None if args.no_plot else (Path(args.plot).expanduser() if args.plot else json_path.with_suffix(".png"))

    y, sr, loader = load_audio(audio_path, args.sr)
    if y.size == 0:
        raise AnalyzeError(f"音频解码结果为空（0 个采样点）：{audio_path}")

    analysis = analyze_audio(
        y, sr, args.levels_fps, args.hop_length, args.n_fft, not args.no_beat_refine
    )
    payload = build_json_payload(
        analysis,
        audio_path,
        sr,
        loader,
        args.levels_fps,
        args.hop_length,
        args.n_fft,
        not args.no_beat_refine,
    )

    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"输入      ：{audio_path}")
    print(f"加载方式  ：{loader}，采样率 {sr} Hz，时长 {analysis['duration']:.3f} s")
    print(f"BPM       ：{analysis['bpm']:.2f}（librosa.beat.beat_track，trim=False）")
    print(
        f"拍点      ：{len(analysis['beats'])} 个，中位间隔 {analysis['checks']['beat_interval_median']:.4f} s"
        f"（抖动 std {analysis['checks']['beat_interval_std']:.4f} s）"
    )
    print(f"对齐修正  ：{analysis['beat_refine_shift'] * 1000:+.2f} ms（onset 峰值中位平移）")
    print(f"downbeats ：{len(analysis['downbeats'])} 个（4/4 假设：beats[::4]）")
    print(
        f"onset     ：{len(analysis['onsets'])} 个；levels {len(analysis['levels'])} 点"
        f" @ {analysis['levels_fps']:.3f} fps"
    )
    for warning in analysis["warnings"]:
        print(f"警告      ：{warning}")
    print(f"已写出    ：{json_path}")

    if png_path is not None:
        render_check_plot(png_path, y, sr, analysis, audio_path.name)
        print(f"校验图    ：{png_path}")
    return json_path, png_path


def main(argv: list[str] | None = None) -> int:
    setup_stdio()
    args = build_parser().parse_args(argv)
    try:
        run(args)
    except AnalyzeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已取消", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
