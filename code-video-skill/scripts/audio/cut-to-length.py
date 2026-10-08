#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""裁切踩点：在拍点网格上为 BGM 选出目标时长的窗口（只输出方案，不改动音频）。

输入：audio-analysis.json（analyze-music.py 产物）+ 目标时长（秒）+ fps + 可选起点。
输出：cut-plan.json —— start_seconds / duration_seconds / start_frame / duration_frames / 对齐信息。

两种方案（目标时长无法整拍对齐时同时给出，并标注取舍）：
  * beat_aligned：整数拍对齐，起止都落在拍点上，时长最接近目标（默认推荐）；
  * exact_seconds：时长精确等于目标，结束点可能落在拍与拍之间。

Remotion 侧消费：<Audio src={...} trimBefore={start_frame} durationInFrames={duration_frames} />。

拍点网格 = 检测到的拍点 + 两端按中位拍长的外推点（外推点会被标记，检测值不改动）。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

TOOL = "scripts/audio/cut-to-length.py"
TIME_PRECISION = 6
EPS = 1e-6


class CutError(RuntimeError):
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
        prog="cut-to-length.py",
        description="在拍点网格上选出目标时长的裁切窗口，输出 cut-plan.json（默认不改动音频文件）。",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            "示例：\n"
            "  python cut-to-length.py --analysis audio-analysis.json --duration 15\n"
            "  python cut-to-length.py -a out/audio-analysis.json -d 30 --fps 60 --start 5.2 -o out/cut-plan.json\n"
            "\n"
            "说明：\n"
            "  * --start 会向前吸附到最近的拍点，吸附偏移记录在输出的对齐信息中；\n"
            "  * 拍点网格两端均按中位拍长外推（不改变已检测到的拍点）；\n"
            "  * 输出仅为参数（帧号），音频本体由 Remotion 的 trimBefore/durationInFrames 裁切。\n"
        ),
    )
    parser.add_argument("-a", "--analysis", required=True, help="analyze-music.py 生成的 audio-analysis.json 路径")
    parser.add_argument("-d", "--duration", type=float, required=True, help="目标时长（秒）")
    parser.add_argument("--fps", type=float, default=30.0, help="视频帧率，用于帧号换算（默认 30）")
    parser.add_argument(
        "--start",
        type=float,
        default=None,
        help="窗口起点（秒，可选；向前吸附到网格，默认取第一个不早于 0 s 的网格点）",
    )
    parser.add_argument("-o", "--output", default=None, help="输出 cut-plan.json 路径（默认：分析文件同目录）")
    parser.add_argument(
        "--emit-film-grid",
        default=None,
        metavar="PATH",
        help=(
            "同时输出成片拍点网格（已减去窗口起点、只含窗口内拍点），\n"
            "可直接喂 verify-audio --beat-grid，不要手工换算。"
        ),
    )
    return parser


class BeatGrid:
    """拍点网格：已知拍点直接取值，两端用中位拍长外推（外推点会被标记）。

    外推是必要的：检测到的首个拍点常晚于 0 s（例如实录曲目第 1 拍在 0.52 s），
    若不外推，所有窗口都会被迫跳过开头；外推点在下游以负索引 / 超界索引标识。
    """

    def __init__(self, beats: list[float]) -> None:
        self.beats = np.asarray(beats, dtype=float)
        intervals = np.diff(self.beats)
        self.beat_seconds = float(np.median(intervals)) if intervals.size else 0.5
        if self.beat_seconds <= 0:
            raise CutError("分析文件中的拍点间隔非正，无法建立网格")
        self.count = int(self.beats.size)
        self.last = float(self.beats[-1])
        # 允许向前外推的步数：外推点时间必须 >= 0
        self.back_steps = int(np.floor(self.beats[0] / self.beat_seconds + EPS))

    def time(self, index: int) -> float:
        if 0 <= index < self.count:
            return float(self.beats[index])
        if index < 0:
            return float(self.beats[0] + index * self.beat_seconds)
        return self.last + (index - (self.count - 1)) * self.beat_seconds

    def is_detected(self, index: int) -> bool:
        return 0 <= index < self.count

    def snap_index(self, seconds: float) -> int:
        """向前（不小于 seconds）吸附到网格索引；超出已有拍点时按外推网格取点。"""
        if seconds <= self.beats[0] + EPS:
            steps = int(np.ceil((seconds - self.beats[0]) / self.beat_seconds - EPS))
            return max(-self.back_steps, min(0, steps))
        index = int(np.searchsorted(self.beats, seconds - EPS, side="left"))
        if index < self.count:
            return index
        steps = int(np.ceil((seconds - self.last) / self.beat_seconds - EPS))
        return self.count - 1 + max(1, steps)

    def max_index_within(self, limit: float) -> int:
        """满足 time(index) <= limit 的最大索引；无解返回 -1。"""
        if limit < self.time(-self.back_steps) - EPS:
            return -1
        if limit < self.beats[0] - EPS:
            return int(np.floor((limit - self.beats[0]) / self.beat_seconds + EPS))
        if limit <= self.last + EPS:
            return int(np.searchsorted(self.beats, limit + 1e-9, side="right")) - 1
        extra = int(np.floor((limit - self.last) / self.beat_seconds + 1e-9))
        return self.count - 1 + extra

    def last_index_le(self, seconds: float) -> int:
        """满足 time(index) <= seconds 的最大索引；无解返回 -1。"""
        return self.max_index_within(seconds)


def load_analysis(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise CutError(f"分析文件不存在：{path}") from None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CutError(f"分析文件不是合法 JSON：{path}（第 {exc.lineno} 行：{exc.msg}）") from None

    for key in ("duration", "beats"):
        if key not in data:
            raise CutError(f"分析文件缺少字段 {key}：{path}（请先用 analyze-music.py 生成）")
    beats = [float(b) for b in data["beats"]]
    if not beats:
        raise CutError("分析文件中的 beats 为空：该曲目节奏不清晰或检测失败，无法在拍点网格上裁切")
    if any(b < 0 for b in beats):
        raise CutError("分析文件中的 beats 存在负值，文件可能已损坏")

    duration = float(data["duration"])
    if duration <= 0:
        raise CutError(f"分析文件中的 duration 非法：{duration}")
    return {
        "duration": duration,
        "bpm": float(data.get("bpm", 0.0)),
        "beats": beats,
        "time_signature": str(data.get("meta", {}).get("time_signature_assumption", "4/4")),
    }


def make_window(
    *,
    scheme: str,
    start_index: int,
    duration_seconds: float,
    end_index: int | None,
    grid: BeatGrid,
    fps: float,
    target_seconds: float,
    audio_duration: float,
    requested_start: float | None,
) -> dict[str, Any]:
    start_seconds = grid.time(start_index)
    end_seconds = start_seconds + duration_seconds

    start_frame = int(round(start_seconds * fps))
    duration_frames = int(round(duration_seconds * fps))
    end_frame = start_frame + duration_frames

    beat_count = (end_index - start_index) if end_index is not None else None
    downbeat_aligned = bool(start_index % 4 == 0 and beat_count is not None and beat_count % 4 == 0)
    start_shift = None if requested_start is None else round(start_seconds - requested_start, TIME_PRECISION)
    end_on_grid = bool(end_index is not None and abs(end_seconds - grid.time(end_index)) <= EPS)

    start_on_grid = bool(abs(start_seconds - grid.time(start_index)) <= EPS)
    # checks 只放本方案自身的断言：整拍方案要求端点落在网格，精确时长方案要求时长等于目标
    checks = {
        "start_on_grid": start_on_grid,
        "frames_match_seconds": bool(
            start_frame == round(start_seconds * fps) and duration_frames == round(duration_seconds * fps)
        ),
        "window_inside_audio": bool(end_seconds <= audio_duration + EPS),
    }
    if beat_count is not None:
        checks["end_on_grid"] = end_on_grid
        checks["duration_is_integer_grid_steps"] = True
    else:
        checks["duration_equals_target"] = bool(abs(duration_seconds - target_seconds) <= EPS)

    return {
        "scheme": scheme,
        "start_seconds": round(start_seconds, TIME_PRECISION),
        "end_seconds": round(end_seconds, TIME_PRECISION),
        "duration_seconds": round(duration_seconds, TIME_PRECISION),
        "start_frame": start_frame,
        "duration_frames": duration_frames,
        "end_frame": end_frame,
        "start_beat_index": start_index,
        "end_beat_index": end_index,
        "beat_count": beat_count,
        "beat_seconds": round(grid.beat_seconds, TIME_PRECISION),
        "local_beat_seconds": round(duration_seconds / beat_count, TIME_PRECISION) if beat_count else None,
        "beat_aligned": beat_count is not None,
        "start_on_grid": start_on_grid,
        "end_on_grid": end_on_grid,
        "start_on_detected_beat": grid.is_detected(start_index),
        "end_on_detected_beat": bool(end_index is not None and grid.is_detected(end_index)),
        "starts_on_downbeat": bool(start_index % 4 == 0),
        "downbeat_aligned": downbeat_aligned,
        "delta_from_target_seconds": round(duration_seconds - target_seconds, TIME_PRECISION),
        "effective_seconds": round(duration_frames / fps, TIME_PRECISION),
        "frame_rounding_error_seconds": round(duration_frames / fps - duration_seconds, TIME_PRECISION),
        "start_frame_error_seconds": round(start_frame / fps - start_seconds, TIME_PRECISION),
        "start_shift_from_request_seconds": start_shift,
        "checks": checks,
        "checks_passed": all(checks.values()),
    }


def build_beat_aligned_window(
    grid: BeatGrid,
    start_index: int,
    target_seconds: float,
    fps: float,
    audio_duration: float,
    requested_start: float | None,
) -> dict[str, Any]:
    max_index = grid.max_index_within(audio_duration)
    if start_index > max_index:
        raise CutError(
            f"起点 {grid.time(start_index):.3f} s 之后没有足够空间："
            f"音频时长 {audio_duration:.3f} s（起点必须早于最后一个可用拍点 {grid.time(max_index):.3f} s）"
        )

    best_n = 0
    best_key: tuple[float, int, int] | None = None
    for beat_count in range(1, max_index - start_index + 1):
        duration = grid.time(start_index + beat_count) - grid.time(start_index)
        delta = abs(duration - target_seconds)
        downbeat_rank = 0 if (start_index % 4 == 0 and beat_count % 4 == 0) else 1
        key = (round(delta, 9), downbeat_rank, beat_count)
        if best_key is None or key < best_key:
            best_key = key
            best_n = beat_count

    if best_n == 0:
        raise CutError("拍点网格不足以容纳任何完整拍：请检查分析文件")

    duration_seconds = grid.time(start_index + best_n) - grid.time(start_index)
    return make_window(
        scheme="beat_aligned",
        start_index=start_index,
        duration_seconds=duration_seconds,
        end_index=start_index + best_n,
        grid=grid,
        fps=fps,
        target_seconds=target_seconds,
        audio_duration=audio_duration,
        requested_start=requested_start,
    )


def build_exact_window(
    grid: BeatGrid,
    start_index: int,
    target_seconds: float,
    fps: float,
    audio_duration: float,
    requested_start: float | None,
) -> dict[str, Any]:
    start_seconds = grid.time(start_index)
    if start_seconds + target_seconds > audio_duration + EPS:
        latest_index = grid.last_index_le(audio_duration - target_seconds)
        if latest_index < 0:
            raise CutError(
                f"目标时长 {target_seconds:.3f} s 超过音频可用长度 {audio_duration:.3f} s，无法裁切"
            )
        start_index = latest_index

    return make_window(
        scheme="exact_seconds",
        start_index=start_index,
        duration_seconds=target_seconds,
        end_index=None,
        grid=grid,
        fps=fps,
        target_seconds=target_seconds,
        audio_duration=audio_duration,
        requested_start=requested_start,
    )


def build_plan(args: argparse.Namespace) -> dict[str, Any]:
    if args.duration <= 0:
        raise CutError(f"--duration 必须为正数，当前为 {args.duration:g}")
    if args.fps <= 0:
        raise CutError(f"--fps 必须为正数，当前为 {args.fps:g}")
    if args.start is not None and args.start < 0:
        raise CutError(f"--start 不能为负，当前为 {args.start:g}")

    analysis_path = Path(args.analysis).expanduser()
    if not analysis_path.is_file():
        raise CutError(f"分析文件不存在：{analysis_path}")
    analysis = load_analysis(analysis_path)

    audio_duration = analysis["duration"]
    if args.duration > audio_duration + EPS:
        raise CutError(
            f"目标时长 {args.duration:.3f} s 超过音频时长 {audio_duration:.3f} s：请缩短目标时长或更换更长的 BGM"
        )

    grid = BeatGrid(analysis["beats"])
    fps_value = int(args.fps) if float(args.fps).is_integer() else args.fps
    # 默认从"第一个不早于 0 s 的网格点"开始；该点可能是首个检测拍点之前的外推点
    start_index = grid.snap_index(0.0 if args.start is None else args.start)
    start_seconds = grid.time(start_index)
    if start_seconds > audio_duration - EPS:
        raise CutError(f"起点 {start_seconds:.3f} s 超出音频时长 {audio_duration:.3f} s")

    aligned = build_beat_aligned_window(
        grid, start_index, args.duration, args.fps, audio_duration, args.start
    )
    exact = build_exact_window(grid, start_index, args.duration, args.fps, audio_duration, args.start)

    recommended = aligned["scheme"]
    alternatives = [exact]

    notes = [
        f"beat_aligned（推荐）：起止都落在拍点上，时长 {aligned['duration_seconds']:.3f} s，"
        f"与目标相差 {aligned['delta_from_target_seconds']:+.3f} s（最大不超过半个拍长）；画面卡点最稳。",
        f"exact_seconds：时长精确为 {exact['duration_seconds']:.3f} s，"
        "但结束点落在拍到拍之间（末尾可能切在半个拍上）；适合平台时长上限等硬性要求。",
        "默认只输出参数，不改动音频文件；Remotion 用 trimBefore/durationInFrames 消费本方案。",
        "downbeats 为 4/4 假设（beats[::4]）；起点是否在强拍见 starts_on_downbeat / downbeat_aligned。",
        "拍点网格两端都按中位拍长外推；已知拍点不做任何修改。",
    ]
    if not aligned["start_on_detected_beat"]:
        notes.append(
            f"起点 {aligned['start_seconds']:.3f} s 位于首个检测拍点之前（外推网格点，索引 "
            f"{aligned['start_beat_index']}）；此时窗口前段的时间轴按中位拍长延续。"
        )
    if not aligned["end_on_detected_beat"]:
        notes.append(
            f"终点 {aligned['end_seconds']:.3f} s 位于末个检测拍点之后（外推网格点，索引 "
            f"{aligned['end_beat_index']}）：结尾精度依赖外推而非实测拍点。"
        )
    if args.start is not None and aligned["start_shift_from_request_seconds"] is not None:
        notes.append(
            f"起点由 {args.start:.3f} s 向前吸附到拍点 {aligned['start_seconds']:.3f} s"
            f"（偏移 {aligned['start_shift_from_request_seconds']:+.3f} s）。"
        )
    if exact["start_seconds"] != aligned["start_seconds"]:
        notes.append(
            f"精确时长方案为放进音频范围，起点另行前移到 {exact['start_seconds']:.3f} s"
            "（整拍方案不受影响）。"
        )
    if aligned["frame_rounding_error_seconds"] != 0:
        notes.append(
            f"帧取整使实际时长变为 {aligned['effective_seconds']:.6f} s"
            f"（误差 {aligned['frame_rounding_error_seconds']:+.6f} s，不足 1 帧）。"
        )

    return {
        "tool": TOOL,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_analysis": analysis_path.name,
        "fps": fps_value,
        "target_seconds": args.duration,
        "requested_start_seconds": args.start,
        "audio": {
            "duration": round(audio_duration, TIME_PRECISION),
            "bpm": round(analysis["bpm"], 4),
            "beat_seconds": round(grid.beat_seconds, TIME_PRECISION),
            "beats_detected": grid.count,
        },
        "assumptions": {
            "time_signature": analysis["time_signature"],
            "beat_seconds_source": "median(相邻拍点间隔)",
            "grid_extrapolation": "两端均按中位拍长外推（外推点仅用于对齐窗口，不修改检测到的拍点）",
            "grid_index_semantics": (
                f"0 <= index < {grid.count} 为检测到的拍点；index < 0 为首拍之前的外推点；"
                f"index >= {grid.count} 为末拍之后的外推点"
            ),
            "frame_conversion": "frame = round(seconds * fps)",
        },
        "window": aligned,
        "alternatives": alternatives,
        "recommended": recommended,
        "notes": notes,
        "remotion": {
            "fps": fps_value,
            "trimBefore": aligned["start_frame"],
            "durationInFrames": aligned["duration_frames"],
            "snippet": (
                f'<Audio src={{staticFile("BGM 文件")}} '
                f"trimBefore={{{aligned['start_frame']}}} durationInFrames={{{aligned['duration_frames']}}} />"
            ),
            "note": "src 请替换为工程 public/ 下的实际 BGM 路径；帧号按本文件 fps 换算",
        },
    }


def build_film_grid(analysis: dict[str, Any], window: dict[str, Any], fps: float) -> dict[str, Any]:
    """把整曲拍点换算到成片时间轴：减去窗口起点，只保留落在窗口内的拍点。"""
    start = float(window["start_seconds"])
    duration = float(window["duration_seconds"])
    beats = [
        round(min(max(t - start, 0.0), duration), TIME_PRECISION)
        for t in analysis["beats"]
        if t - start >= -EPS and t - start <= duration + EPS
    ]
    return {
        "window_start_seconds": round(start, TIME_PRECISION),
        "fps": fps,
        "duration_seconds": round(duration, TIME_PRECISION),
        "beats": beats,
        "note": (
            "已换算到成片时间轴（t - window.start_seconds，只含窗口内拍点）；"
            "可直接用于 verify-audio --beat-grid"
        ),
    }


def run(args: argparse.Namespace) -> Path:
    plan = build_plan(args)
    output_path = (
        Path(args.output).expanduser()
        if args.output
        else Path(args.analysis).expanduser().parent / "cut-plan.json"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    window = plan["window"]
    alternative = plan["alternatives"][0]
    print(f"目标      ：{plan['target_seconds']:g} s @ {plan['fps']:g} fps")
    print(
        f"推荐方案  ：{window['scheme']}  {window['start_seconds']:.3f} s → {window['end_seconds']:.3f} s"
        f"（{window['duration_seconds']:.3f} s，{window['beat_count']} 拍，"
        f"偏差 {window['delta_from_target_seconds']:+.3f} s）"
    )
    print(f"帧号      ：trimBefore={window['start_frame']}，durationInFrames={window['duration_frames']}")
    print(
        f"备选方案  ：{alternative['scheme']}  {alternative['start_seconds']:.3f} s →"
        f" {alternative['end_seconds']:.3f} s（{alternative['duration_seconds']:.3f} s，"
        f"偏差 {alternative['delta_from_target_seconds']:+.3f} s）"
    )
    print(f"对齐校验  ：{'通过' if window['checks_passed'] else '未通过：' + str(window['checks'])}")
    if args.emit_film_grid:
        film_grid_path = Path(args.emit_film_grid).expanduser()
        film_grid_path.parent.mkdir(parents=True, exist_ok=True)
        film_grid = build_film_grid(load_analysis(Path(args.analysis).expanduser()), window, plan["fps"])
        film_grid_path.write_text(json.dumps(film_grid, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"成片网格  ：{film_grid_path}（{len(film_grid['beats'])} 拍，已减去窗口起点）")
    print(f"已写出    ：{output_path}")
    return output_path


def main(argv: list[str] | None = None) -> int:
    setup_stdio()
    args = build_parser().parse_args(argv)
    try:
        run(args)
    except CutError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已取消", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
