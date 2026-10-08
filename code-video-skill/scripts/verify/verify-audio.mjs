#!/usr/bin/env node
/**
 * 音频体检：
 *   · 响度：loudnorm 的集成响度（Integrated）与响度范围（LRA）
 *   · 真峰：以解码后的 PCM 为准（loudnorm 的 dBTP），不看容器元数据
 *   · 静音段：silencedetect，同时给出反面——发声段（音效落点）
 *   · AAC 参数与码率：采样率 / 声道 / profile / 流码率 / 容器总码率
 *   · 时长核对：--expect-duration 与容器/流时长逐项比（音床、裁切踩点都用得上）
 *   · 拍点对齐：--beat-grid 用 analyze-music.py 的 JSON 检查打击点是否落在网格上
 *   · 首尾边界：--edge-window 检查首尾窗口的峰值，卡掉硬切爆音
 *
 * 阈值都可通过命令行覆盖，默认值对齐模板基线（真峰必须在 -1 dBTP 以内）。
 * 退出码：0 = 通过；1 = 有告警；2 = 用法错误或环境问题。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CliError,
  Report,
  assertFile,
  assertSuccess,
  describeTools,
  displayPath,
  formatBitRate,
  formatNumber,
  formatSeconds,
  parseArgs,
  readMediaInfo,
  resolveTools,
  runFfmpeg,
  runMain,
} from "./lib.mjs";

const TOOL = "verify-audio";
const USAGE = "node scripts/verify/verify-audio.mjs <mp4> [选项]";

/** JSON 里明细数组的上限：极长的静音列表对自动化没有价值，超出的只留计数。 */
const JSON_SEGMENT_LIMIT = 500;

const SPEC = {
  json: { type: "boolean", help: "输出完整 JSON（stdout 只有 JSON）" },
  "max-tp": {
    type: "number",
    default: -1,
    valueHint: "dBTP",
    help: "真峰上限：超过即告警（模板基线 -1）",
  },
  "min-lufs": {
    type: "number",
    default: -40,
    valueHint: "LUFS",
    help: "集成响度下限：低于即告警（点状音效、大量静音时基数偏低属正常）",
  },
  "max-lufs": {
    type: "number",
    default: -9,
    valueHint: "LUFS",
    help: "集成响度上限：高于即告警（交付安全区）",
  },
  "min-kbps": {
    type: "number",
    default: 64,
    valueHint: "kbps",
    help: "AAC 流码率下限：低于即告警；0 = 不检查",
  },
  "silence-noise": {
    type: "number",
    default: -50,
    valueHint: "dB",
    help: "静音判定门限（silencedetect noise）",
  },
  "silence-duration": {
    type: "number",
    default: 0.4,
    valueHint: "秒",
    help: "静音段最短时长（silencedetect d）",
  },
  "max-silence": {
    type: "number",
    default: 0,
    valueHint: "秒",
    help: "单段静音上限：超过即告警；0 = 只报告不告警",
  },
  "list-limit": {
    type: "number",
    default: 10,
    valueHint: "N",
    help: "摘要与 JSON 里最多列出的静音段条数",
  },
  "expect-duration": {
    type: "number",
    valueHint: "秒",
    help: "期望时长：与容器时长、音频流时长逐一核对（不传 = 不检查）",
  },
  "duration-tolerance": {
    type: "number",
    default: 0.002,
    valueHint: "秒",
    help: "时长允许偏差（默认 0.002）",
  },
  "beat-grid": {
    type: "string",
    valueHint: "JSON",
    help: "拍点网格 JSON（analyze-music.py 的输出）：检查打击点是否落在拍点上",
  },
  "beat-tolerance": {
    type: "number",
    default: 0.03,
    valueHint: "秒",
    help: "打击点与最近拍点的允许偏差：看中位值（默认 0.03）",
  },
  "beat-margin-db": {
    type: "number",
    default: 8,
    valueHint: "dB",
    help: "拍点上瞬态峰值相对拍间电平的最小余量（默认 8）",
  },
  "beat-min-coverage": {
    type: "number",
    default: 0.8,
    valueHint: "0-1",
    help: "达标拍点的比例下限（默认 0.8）",
  },
  "edge-window": {
    type: "number",
    default: 0,
    valueHint: "ms",
    help: "首尾爆音检查窗口；0 = 关闭（音床/成片建议 5）",
  },
  "edge-max-db": {
    type: "number",
    default: -40,
    valueHint: "dB",
    help: "首尾窗口内的峰值上限（默认 -40）",
  },
};

/** `-inf`（整片静音）要当成负无穷，而不是 NaN。 */
function parseLoudnessValue(raw) {
  const text = String(raw ?? "").trim();
  if (text === "-inf" || text === "-Infinity") return -Infinity;
  if (text === "inf" || text === "Infinity") return Infinity;
  const value = Number(text);
  return Number.isFinite(value) ? value : NaN;
}

/** loudnorm 单遍测量：只读输入（print_format=json），输出丢弃。 */
async function measureLoudness(file) {
  const result = await runFfmpeg([
    "-i",
    file,
    "-map",
    "0:a:0",
    "-af",
    "loudnorm=print_format=json",
    "-f",
    "null",
    "-",
  ]);
  assertSuccess(result, "响度测量（loudnorm）");
  const match = /\{[^{}]*"input_i"[^{}]*\}/.exec(result.stderr);
  if (!match) {
    throw new CliError(
      `没有从 loudnorm 读到测量结果：\n${result.stderr.split(/\r?\n/).slice(-8).join("\n")}`,
    );
  }
  const summary = JSON.parse(match[0]);
  return {
    integratedLufs: parseLoudnessValue(summary.input_i),
    truePeakDbtp: parseLoudnessValue(summary.input_tp),
    lra: parseLoudnessValue(summary.input_lra),
    thresholdLufs: parseLoudnessValue(summary.input_thresh),
    targetOffset: parseLoudnessValue(summary.target_offset),
    raw: summary,
  };
}

/**
 * 静音段检测。
 * silencedetect 在"文件以静音收尾"时不一定补 silence_end，所以最后一段用总时长补齐。
 */
async function detectSilence(file, { noise, duration, totalSeconds }) {
  const result = await runFfmpeg([
    "-i",
    file,
    "-map",
    "0:a:0",
    "-af",
    `silencedetect=noise=${noise}dB:d=${duration}`,
    "-f",
    "null",
    "-",
  ]);
  assertSuccess(result, "静音段检测（silencedetect）");

  const segments = [];
  let start = null;
  for (const line of result.stderr.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (startMatch) {
      start = Number(startMatch[1]);
      continue;
    }
    const endMatch =
      /silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(
        line,
      );
    if (endMatch) {
      const end = Number(endMatch[1]);
      const length = Number(endMatch[2]);
      segments.push({
        start: start ?? Math.max(0, end - length),
        end,
        duration: length,
      });
      start = null;
    }
  }
  if (start !== null && Number.isFinite(totalSeconds)) {
    segments.push({ start, end: totalSeconds, duration: totalSeconds - start });
  }

  // 发声段 = 整条时间轴上减掉静音段（音效落点的可见证据）
  const sounding = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.start > cursor + 1e-3)
      sounding.push({ start: cursor, end: segment.start });
    cursor = Math.max(cursor, segment.end);
  }
  if (Number.isFinite(totalSeconds) && cursor < totalSeconds - 1e-3) {
    sounding.push({ start: cursor, end: totalSeconds });
  }

  return { segments, sounding };
}

/* ─────────────────────────── PCM 侧检查（时长 / 拍点 / 首尾） ─────────────────────────── */

const toDb = (amplitude) =>
  amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;

/**
 * 解码成单声道 Float32 PCM。
 * 输入是 WAV 还是 MP4 都走同一条 ffmpeg 路径，避免在 Node 里各写一套容器解析。
 */
async function decodePcmMono(file, sampleRate) {
  const workDir = await mkdtemp(path.join(tmpdir(), "verify-audio-"));
  const pcmPath = path.join(workDir, "pcm.f32le");
  try {
    const result = await runFfmpeg([
      "-y",
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      pcmPath,
    ]);
    assertSuccess(result, "解码 PCM（用于拍点 / 首尾检查）");
    const raw = await readFile(pcmPath);
    const samples = new Float32Array(raw.length >> 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = raw.readFloatLE(index * 4);
    }
    return samples;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const quantile = (sorted, ratio) => {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

/**
 * 打击点检测：RMS 包络上的新颖度（正跳升）极值。
 *
 * 判据刻意保持简单（无 FFT）：节奏层是脉冲型的，包络上升沿足够可靠；氛围垫、
 * riser 这类连续声音的电平变化平缓，不会产生陡升沿，不污染结果。检出后用窗口内
 * 绝对值最大的样本把起音时刻 refine 到样本精度，避免被跳格量化。
 *
 * 为什么要"跳升 + 更大范围内的极大值"而不是"跳升且当帧就是局部最大"：
 * 打击点的 RMS 峰值通常出现在起音之后十几毫秒（包络还在涨），两者会互相排斥，
 * 结果一个点都检不出来。所以先在 ±peakWindowMs 内找新颖度（正跳升）的极大值，
 * 再用该窗口内的最大样本 refine 出起音时刻。
 */
function detectOnsets(samples, sampleRate, options = {}) {
  const windowMs = options.windowMs ?? 6;
  const hopMs = options.hopMs ?? 2;
  const riseDb = options.riseDb ?? 4;
  const aboveFloorDb = options.aboveFloorDb ?? 5;
  const peakWindowMs = options.peakWindowMs ?? 50;
  const refractorySeconds = options.refractorySeconds ?? 0.08;

  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const window = Math.max(hop, Math.round((sampleRate * windowMs) / 1000));
  const frames = [];
  for (let start = 0; start + window <= samples.length; start += hop) {
    let sum = 0;
    for (let index = start; index < start + window; index += 1) {
      sum += samples[index] * samples[index];
    }
    frames.push({ at: start / sampleRate, rms: Math.sqrt(sum / window) });
  }
  if (frames.length === 0) return [];

  const sortedRms = frames.map((frame) => frame.rms).sort((a, b) => a - b);
  const floorDb = toDb(quantile(sortedRms, 0.5));

  // 新颖度：相邻两跳的电平抬升（只取上升方向）
  const novelty = frames.map((frame, index) =>
    index === 0
      ? 0
      : Math.max(0, toDb(frame.rms) - toDb(frames[index - 1].rms)),
  );
  const radius = Math.max(1, Math.round(peakWindowMs / hopMs));

  const onsets = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (novelty[index] < riseDb) continue;
    if (toDb(frames[index].rms) < floorDb + aboveFloorDb) continue;

    let isPeak = true;
    for (
      let probe = Math.max(0, index - radius);
      probe <= Math.min(frames.length - 1, index + radius);
      probe += 1
    ) {
      if (novelty[probe] > novelty[index]) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;

    // 用"起音窗口 + 20ms"内的最大样本 refine 起音时刻
    const start = Math.max(0, Math.round(frames[index].at * sampleRate));
    const end = Math.min(
      samples.length,
      start + window + Math.round(sampleRate * 0.02),
    );
    let peakAt = start;
    let peakValue = -1;
    for (let cursor = start; cursor < end; cursor += 1) {
      const magnitude = Math.abs(samples[cursor]);
      if (magnitude > peakValue) {
        peakValue = magnitude;
        peakAt = cursor;
      }
    }
    const at = peakAt / sampleRate;
    if (
      onsets.length > 0 &&
      at - onsets[onsets.length - 1] < refractorySeconds
    ) {
      continue;
    }
    onsets.push(at);
  }
  return onsets;
}

/** 打击点与拍点网格的偏差统计（精度）：中位 / p90 / 最大偏差。 */
function analyzeAlignment(onsets, beats, tolerance) {
  const offsets = onsets.map((at) => {
    let nearest = beats[0] ?? 0;
    for (const beat of beats) {
      if (Math.abs(beat - at) < Math.abs(nearest - at)) nearest = beat;
    }
    return { at, beat: nearest, offset: at - nearest };
  });
  const distances = offsets
    .map((item) => Math.abs(item.offset))
    .sort((a, b) => a - b);

  return {
    onsetCount: onsets.length,
    beatCount: beats.length,
    matchedOnsets: distances.filter((distance) => distance <= tolerance).length,
    medianOffsetSeconds: quantile(distances, 0.5),
    p90OffsetSeconds: quantile(distances, 0.9),
    maxOffsetSeconds: distances.length ? distances[distances.length - 1] : 0,
    offsets: offsets.map((item) => ({
      at: Number(item.at.toFixed(4)),
      beat: Number(item.beat.toFixed(4)),
      offsetMs: Number((item.offset * 1000).toFixed(1)),
    })),
  };
}

const rmsOf = (samples, fromSeconds, toSeconds, sampleRate) => {
  const from = Math.max(0, Math.round(fromSeconds * sampleRate));
  const to = Math.min(samples.length, Math.round(toSeconds * sampleRate));
  if (to <= from) return 0;
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / (to - from));
};

const peakOf = (samples, fromSeconds, toSeconds, sampleRate) => {
  const from = Math.max(0, Math.round(fromSeconds * sampleRate));
  const to = Math.min(samples.length, Math.round(toSeconds * sampleRate));
  let peak = 0;
  for (let index = from; index < to; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index]));
  }
  return peak;
};

/**
 * 逐拍"有没有东西响"：拍点窗口的**瞬态峰值**相对拍间窗口 RMS 的余量。
 *
 * 为什么不用窗口 RMS 比：节奏层的滴答很短，摊到 60ms 窗口里会被持续垫音稀释，
 * 余量只剩几个 dB，判据既钝又容易误伤。峰值对瞬态敏感，垫音（持续、低峰值因数）
 * 不会抬高它，因此"峰值得比垫音高多少"才是这条编排纪律的直接度量。
 * 太靠文件首尾的拍点不参与判定（淡入淡出会压掉它们）。
 */
function beatPresence(samples, sampleRate, beats, options = {}) {
  const lookBehind = options.lookBehindSeconds ?? 0.015;
  const lookAhead = options.lookAheadSeconds ?? 0.045;
  const guardSeconds = options.guardSeconds ?? 0.2;
  const totalSeconds = samples.length / sampleRate;

  // 拍距取中位数：真实拍点有毫秒级抖动，用平均值会累积漂移
  const intervals = [];
  for (let index = 1; index < beats.length; index += 1) {
    intervals.push(beats[index] - beats[index - 1]);
  }
  const interval =
    intervals.length > 0
      ? quantile(
          [...intervals].sort((a, b) => a - b),
          0.5,
        )
      : 0.5;
  const half = interval / 2;

  const perBeat = [];
  for (const beat of beats) {
    if (beat < guardSeconds || beat > totalSeconds - guardSeconds) continue;
    const onPeak = peakOf(
      samples,
      beat - lookBehind,
      beat + lookAhead,
      sampleRate,
    );
    const reference = Math.max(
      rmsOf(samples, beat - half - 0.015, beat - half + 0.045, sampleRate),
      rmsOf(samples, beat + half - 0.015, beat + half + 0.045, sampleRate),
      1e-9,
    );
    perBeat.push({
      beat: Number(beat.toFixed(4)),
      peakDb: toDb(onPeak),
      referenceDb: toDb(reference),
      marginDb: Number((toDb(onPeak) - toDb(reference)).toFixed(2)),
    });
  }

  const margins = perBeat.map((item) => item.marginDb).sort((a, b) => a - b);
  return {
    beatCount: perBeat.length,
    intervalSeconds: Number(interval.toFixed(4)),
    medianMarginDb: quantile(margins, 0.5),
    minMarginDb: margins.length ? margins[0] : 0,
    maxMarginDb: margins.length ? margins[margins.length - 1] : 0,
    perBeat,
  };
}

/** 首尾窗口峰值：硬切（爆音）的最直接证据。 */
function edgePeaks(samples, sampleRate, windowMs) {
  const window = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const head = samples.subarray(0, Math.min(window, samples.length));
  const tail = samples.subarray(Math.max(0, samples.length - window));
  const peakOf = (view) => {
    let peak = 0;
    for (const sample of view) peak = Math.max(peak, Math.abs(sample));
    return peak;
  };
  return { headDb: toDb(peakOf(head)), tailDb: toDb(peakOf(tail)) };
}

/** 读拍点网格：兼容 analyze-music.py 的输出，也接受裸数组。 */
async function loadBeatGrid(file, totalSeconds) {
  const absolute = assertFile(file, "拍点网格 JSON").path;
  const parsed = JSON.parse(await readFile(absolute, "utf8"));
  const pick = (value) =>
    Array.isArray(value)
      ? value.map(Number).filter((item) => Number.isFinite(item))
      : [];
  const beats = pick(
    parsed.beats ?? (Array.isArray(parsed) ? parsed : undefined),
  );
  const downbeats = pick(parsed.downbeats);
  const grid = (beats.length > 0 ? beats : downbeats).filter(
    (beat) => beat >= 0 && beat <= totalSeconds + 0.5,
  );
  if (grid.length === 0) {
    throw new CliError(
      `拍点网格里没有可用的 beats / downbeats：${displayPath(absolute)}`,
    );
  }
  return {
    path: absolute,
    bpm: Number(parsed.bpm) || null,
    beats: grid,
    source: beats.length > 0 ? "beats" : "downbeats",
  };
}

runMain(async () => {
  const { values, positionals } = parseArgs(process.argv.slice(2), SPEC, {
    tool: TOOL,
    usage: USAGE,
    description: "音频体检：响度 / 真峰 / 静音段 / AAC 参数",
  });
  if (positionals.length !== 1) {
    throw new CliError(
      `需要且只需要一个成片路径（收到 ${positionals.length} 个，--help 查看用法）`,
    );
  }

  const file = assertFile(positionals[0], "成片");
  const tools = await resolveTools();
  const report = new Report(TOOL, {
    json: values.json,
    subjects: [displayPath(file.path)],
  });
  report.note(describeTools(tools));

  const info = await readMediaInfo(file.path);
  const audio = info.audio;
  if (!audio) {
    report.problem("no-audio-stream", "文件里没有音频流（成片静音）");
    report.data({ audio: null });
    return report.emit();
  }

  const sampleRate = Number(audio.sample_rate);
  const totalSeconds = Number(audio.duration ?? info.format.duration);
  const streamBitRate = Number(audio.bit_rate);
  const aacFrameMs =
    audio.codec_name === "aac" && sampleRate
      ? (1024 / sampleRate) * 1000
      : null;

  report.section("音频流", [
    [
      "编码",
      `${audio.codec_name ?? "未知"}${audio.profile ? ` (${audio.profile})` : ""}`,
    ],
    ["采样率", Number.isFinite(sampleRate) ? `${sampleRate} Hz` : "未知"],
    [
      "声道",
      `${audio.channels ?? "?"}ch${audio.channel_layout ? ` (${audio.channel_layout})` : ""}`,
    ],
    [
      "流码率",
      formatBitRate(streamBitRate),
      values["min-kbps"] > 0 &&
      Number.isFinite(streamBitRate) &&
      streamBitRate / 1000 < values["min-kbps"]
        ? "warn"
        : undefined,
    ],
    ["容器总码率", formatBitRate(info.format.bit_rate)],
    ["时长", formatSeconds(totalSeconds)],
    [
      "音频帧",
      `${audio.nb_frames ?? "未知"} 帧${aacFrameMs ? ` · ${aacFrameMs.toFixed(2)} ms/帧` : ""}`,
    ],
  ]);

  /* ── 响度与真峰 ── */
  const loudness = await measureLoudness(file.path);
  const peak = loudness.truePeakDbtp;
  const integrated = loudness.integratedLufs;
  report.section("响度（解码后 PCM）", [
    [
      "集成响度",
      Number.isFinite(integrated)
        ? `${formatNumber(integrated)} LUFS`
        : integrated === -Infinity
          ? "-∞ LUFS（整片静音）"
          : "未知",
      integrated === -Infinity ||
      integrated > values["max-lufs"] ||
      integrated < values["min-lufs"]
        ? "warn"
        : "ok",
    ],
    [
      "真峰",
      Number.isFinite(peak)
        ? `${formatNumber(peak)} dBTP`
        : peak === -Infinity
          ? "-∞ dBTP"
          : "未知",
      Number.isFinite(peak) && peak > values["max-tp"] ? "warn" : "ok",
    ],
    [
      "响度范围 LRA",
      Number.isFinite(loudness.lra)
        ? `${formatNumber(loudness.lra)} LU`
        : "未知",
    ],
    [
      "测量门限",
      Number.isFinite(loudness.thresholdLufs)
        ? `${formatNumber(loudness.thresholdLufs)} LUFS`
        : "未知",
    ],
  ]);
  report.note(
    `阈值：真峰 ≤ ${values["max-tp"]} dBTP，集成响度 ${values["min-lufs"]} ~ ${values["max-lufs"]} LUFS；` +
      "音效为点状事件时集成响度基数偏低属正常。",
  );

  /* ── 静音段与发声段 ── */
  const silence = await detectSilence(file.path, {
    noise: values["silence-noise"],
    duration: values["silence-duration"],
    totalSeconds,
  });
  const silenceTotal = silence.segments.reduce(
    (sum, segment) => sum + segment.duration,
    0,
  );
  const longest = silence.segments.reduce(
    (best, segment) =>
      !best || segment.duration > best.duration ? segment : best,
    null,
  );
  const silenceRatio =
    Number.isFinite(totalSeconds) && totalSeconds > 0
      ? silenceTotal / totalSeconds
      : NaN;

  report.section(
    `静音段（≤ ${values["silence-noise"]} dB 且 ≥ ${values["silence-duration"]}s）`,
    [
      ["段数", `${silence.segments.length}`],
      [
        "静音总长",
        `${formatSeconds(silenceTotal)}${Number.isFinite(silenceRatio) ? `（占 ${(silenceRatio * 100).toFixed(1)}%）` : ""}`,
        Number.isFinite(silenceRatio) && silenceRatio > 0.995
          ? "warn"
          : undefined,
      ],
      [
        "最长静音段",
        longest
          ? `${formatSeconds(longest.duration)} @ ${formatSeconds(longest.start)}→${formatSeconds(longest.end)}`
          : "无",
        values["max-silence"] > 0 &&
        longest &&
        longest.duration > values["max-silence"]
          ? "warn"
          : undefined,
      ],
      ["发声段", `${silence.sounding.length} 段`],
    ],
  );
  if (silence.sounding.length) {
    report.note(
      `发声段落点：${silence.sounding
        .slice(0, values["list-limit"])
        .map(
          (segment) =>
            `${formatSeconds(segment.start)}→${formatSeconds(segment.end)}`,
        )
        .join(
          "，",
        )}${silence.sounding.length > values["list-limit"] ? " …" : ""}`,
    );
  }

  /* ── 时长核对：音床 / 裁切踩点的硬判据 ── */
  const dbText = (value) =>
    Number.isFinite(value)
      ? `${formatNumber(value)} dBFS`
      : value === -Infinity
        ? "-∞ dBFS"
        : "未知";

  const expectedDuration = values["expect-duration"];
  const durationTolerance = values["duration-tolerance"];
  const containerDuration = Number(info.format.duration);
  /**
   * 音频流时长与容器时长天然差一个编码帧（AAC 的 priming/padding，实测 1024/48000 ≈ 21ms
   * 会让 10s 成片的音频流显示 9.984s）。容器时长按 --duration-tolerance 判，
   * 音频流放宽一个编码帧，避免把编码器行为当成内容错误。
   */
  const codecFrameSeconds =
    audio.codec_name === "aac" && Number.isFinite(sampleRate) && sampleRate > 0
      ? 1024 / sampleRate
      : 0;
  const streamTolerance = durationTolerance + codecFrameSeconds;
  let durationCheck = null;
  if (expectedDuration !== undefined) {
    const containerDrift = Math.abs(containerDuration - expectedDuration);
    const streamDrift = Number.isFinite(totalSeconds)
      ? Math.abs(totalSeconds - expectedDuration)
      : NaN;
    durationCheck = {
      expectedSeconds: expectedDuration,
      toleranceSeconds: durationTolerance,
      streamToleranceSeconds: streamTolerance,
      containerDriftSeconds: containerDrift,
      streamDriftSeconds: Number.isFinite(streamDrift) ? streamDrift : null,
      sampleCount: Number(audio.nb_frames) || null,
    };
    report.section("时长核对", [
      ["期望时长", formatSeconds(expectedDuration)],
      [
        "容器时长",
        `${formatSeconds(containerDuration)}（偏差 ${containerDrift.toFixed(6)}s）`,
        containerDrift > durationTolerance ? "warn" : "ok",
      ],
      [
        "音频流时长",
        Number.isFinite(streamDrift)
          ? `${formatSeconds(totalSeconds)}（偏差 ${streamDrift.toFixed(6)}s）`
          : "未知",
        Number.isFinite(streamDrift) && streamDrift > streamTolerance
          ? "warn"
          : undefined,
      ],
      ["样本数", Number(audio.nb_frames) ? `${audio.nb_frames}` : "未知"],
      [
        "容许偏差",
        `容器 ±${durationTolerance}s` +
          (codecFrameSeconds > 0
            ? ` · 音频流 ±${streamTolerance.toFixed(4)}s（含 1 个 AAC 帧）`
            : ` · 音频流 ±${streamTolerance}s`),
      ],
    ]);
    if (containerDrift > durationTolerance) {
      report.problem(
        "expect-duration",
        `容器时长 ${formatSeconds(containerDuration)} 与期望 ${formatSeconds(expectedDuration)} 相差 ${containerDrift.toFixed(6)}s，超过 ±${durationTolerance}s`,
      );
    }
    if (Number.isFinite(streamDrift) && streamDrift > streamTolerance) {
      report.problem(
        "expect-duration",
        `音频流时长 ${formatSeconds(totalSeconds)} 与期望 ${formatSeconds(expectedDuration)} 相差 ${streamDrift.toFixed(6)}s，超过 ±${streamTolerance.toFixed(4)}s（已含 1 个 AAC 帧的编码余量）`,
      );
    }
  }

  /* ── 拍点对齐与首尾边界：都要解码 PCM ── */
  const beatGrid = values["beat-grid"]
    ? await loadBeatGrid(values["beat-grid"], totalSeconds)
    : null;
  const edgeWindowMs = values["edge-window"];
  const needsPcm = beatGrid !== null || edgeWindowMs > 0;
  const pcmSampleRate =
    Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const pcm = needsPcm ? await decodePcmMono(file.path, pcmSampleRate) : null;

  let alignment = null;
  let presence = null;
  if (beatGrid && pcm) {
    const tolerance = values["beat-tolerance"];
    const marginDb = values["beat-margin-db"];
    const minCoverage = values["beat-min-coverage"];

    alignment = analyzeAlignment(
      detectOnsets(pcm, pcmSampleRate),
      beatGrid.beats,
      tolerance,
    );
    presence = beatPresence(pcm, pcmSampleRate, beatGrid.beats);
    const covered = presence.perBeat.filter(
      (item) => item.marginDb >= marginDb,
    ).length;
    const coverage = presence.beatCount > 0 ? covered / presence.beatCount : 1;

    report.section("拍点对齐", [
      [
        "网格",
        `${beatGrid.beats.length} 拍${beatGrid.bpm ? ` @ ${formatNumber(beatGrid.bpm)} BPM` : ""}` +
          `（${beatGrid.source} · 拍距 ${(presence.intervalSeconds * 1000).toFixed(1)}ms）`,
      ],
      [
        "检出打击点",
        `${alignment.onsetCount} 个 · 命中拍点 ${alignment.matchedOnsets} 个`,
      ],
      [
        "打击点偏差",
        `中位 ${(alignment.medianOffsetSeconds * 1000).toFixed(1)}ms · ` +
          `p90 ${(alignment.p90OffsetSeconds * 1000).toFixed(1)}ms · ` +
          `最大 ${(alignment.maxOffsetSeconds * 1000).toFixed(1)}ms`,
        alignment.medianOffsetSeconds > tolerance ? "warn" : "ok",
      ],
      [
        "拍点瞬态余量",
        `中位 ${formatNumber(presence.medianMarginDb)}dB · ` +
          `最小 ${formatNumber(presence.minMarginDb)}dB`,
        coverage < minCoverage ? "warn" : "ok",
      ],
      [
        "达标拍点",
        `${covered}/${presence.beatCount}（${(coverage * 100).toFixed(1)}%）`,
        coverage < minCoverage ? "warn" : "ok",
      ],
      [
        "判据",
        `偏差中位 ≤ ±${(tolerance * 1000).toFixed(0)}ms · ` +
          `余量 ≥ ${marginDb}dB 的拍点 ≥ ${(minCoverage * 100).toFixed(0)}%`,
      ],
    ]);
    report.note(
      "拍点检查只看节奏层：偏差用检出的打击点算，余量用拍点窗口峰值比对拍间电平——" +
        "垫音、riser 这类连续声音不会抬高它，因此这条判据不受整体响度影响。",
    );
    if (alignment.onsetCount > 0 && alignment.medianOffsetSeconds > tolerance) {
      report.problem(
        "beat-alignment",
        `打击点中位偏差 ${(alignment.medianOffsetSeconds * 1000).toFixed(1)}ms 超过 ±${(tolerance * 1000).toFixed(0)}ms`,
      );
    }
    if (coverage < minCoverage) {
      report.problem(
        "beat-coverage",
        `拍点瞬态余量达标的只有 ${covered}/${presence.beatCount}（${(coverage * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(0)}%）：有拍点上没有可辨的节奏事件`,
      );
    }
  }

  let edges = null;
  if (edgeWindowMs > 0 && pcm) {
    edges = edgePeaks(pcm, pcmSampleRate, edgeWindowMs);
    const maxDb = values["edge-max-db"];
    report.section(`首尾边界（各 ${edgeWindowMs}ms）`, [
      [
        "起始窗口峰值",
        dbText(edges.headDb),
        edges.headDb > maxDb ? "warn" : "ok",
      ],
      [
        "结束窗口峰值",
        dbText(edges.tailDb),
        edges.tailDb > maxDb ? "warn" : "ok",
      ],
      ["阈值", `≤ ${maxDb} dBFS`],
    ]);
    if (edges.headDb > maxDb || edges.tailDb > maxDb) {
      report.problem(
        "edge-click",
        `首尾窗口峰值（起始 ${dbText(edges.headDb)} / 结束 ${dbText(edges.tailDb)}）超过 ${maxDb} dBFS：多半是硬切，需要淡入淡出`,
      );
    }
  }

  report.data({
    file: { path: file.path, sizeBytes: file.sizeBytes },
    audioStream: audio,
    container: info.format,
    durationCheck,
    alignment: alignment
      ? {
          gridPath: displayPath(beatGrid.path),
          gridSource: beatGrid.source,
          gridBeats: beatGrid.beats.length,
          bpm: beatGrid.bpm,
          toleranceSeconds: values["beat-tolerance"],
          ...alignment,
          offsets: alignment.offsets.slice(0, JSON_SEGMENT_LIMIT),
        }
      : null,
    presence: presence
      ? {
          gridPath: displayPath(beatGrid.path),
          marginDb: values["beat-margin-db"],
          minCoverage: values["beat-min-coverage"],
          coverage:
            presence.beatCount > 0
              ? presence.perBeat.filter(
                  (item) => item.marginDb >= values["beat-margin-db"],
                ).length / presence.beatCount
              : 1,
          ...presence,
          perBeat: presence.perBeat.slice(0, JSON_SEGMENT_LIMIT),
        }
      : null,
    edges: edges
      ? {
          windowMs: edgeWindowMs,
          maxDb: values["edge-max-db"],
          headDb: Number.isFinite(edges.headDb) ? edges.headDb : null,
          tailDb: Number.isFinite(edges.tailDb) ? edges.tailDb : null,
        }
      : null,
    loudness: {
      integratedLufs: Number.isFinite(integrated) ? integrated : null,
      integratedIsSilent: integrated === -Infinity,
      truePeakDbtp: Number.isFinite(peak) ? peak : null,
      lra: Number.isFinite(loudness.lra) ? loudness.lra : null,
      thresholdLufs: Number.isFinite(loudness.thresholdLufs)
        ? loudness.thresholdLufs
        : null,
      targetOffset: Number.isFinite(loudness.targetOffset)
        ? loudness.targetOffset
        : null,
      raw: loudness.raw,
      thresholds: {
        maxTp: values["max-tp"],
        minLufs: values["min-lufs"],
        maxLufs: values["max-lufs"],
      },
    },
    silence: {
      noiseDb: values["silence-noise"],
      minDurationSeconds: values["silence-duration"],
      totalSeconds: silenceTotal,
      ratio: Number.isFinite(silenceRatio) ? silenceRatio : null,
      segmentCount: silence.segments.length,
      segments: silence.segments.slice(0, JSON_SEGMENT_LIMIT),
      segmentsTruncated: silence.segments.length > JSON_SEGMENT_LIMIT,
      longest,
      sounding: silence.sounding.slice(0, JSON_SEGMENT_LIMIT),
      soundingCount: silence.sounding.length,
    },
  });

  /* ── 告警汇总 ── */
  if (
    values["min-kbps"] > 0 &&
    Number.isFinite(streamBitRate) &&
    streamBitRate / 1000 < values["min-kbps"]
  ) {
    report.problem(
      "audio-bitrate",
      `AAC 流码率 ${formatBitRate(streamBitRate)} 低于 ${values["min-kbps"]} kbps`,
    );
  }
  if (integrated === -Infinity) {
    report.problem(
      "silent-track",
      "整条音轨是静音（集成响度 -∞），成片没有可听内容",
    );
  } else if (Number.isFinite(integrated) && integrated < values["min-lufs"]) {
    report.problem(
      "loudness-low",
      `集成响度 ${formatNumber(integrated)} LUFS 低于 ${values["min-lufs"]} LUFS`,
    );
  } else if (Number.isFinite(integrated) && integrated > values["max-lufs"]) {
    report.problem(
      "loudness-high",
      `集成响度 ${formatNumber(integrated)} LUFS 高于 ${values["max-lufs"]} LUFS`,
    );
  }
  if (Number.isFinite(peak) && peak > values["max-tp"]) {
    report.problem(
      "true-peak",
      `真峰 ${formatNumber(peak)} dBTP 超过 ${values["max-tp"]} dBTP（解码后测量，有削波风险）`,
    );
  }
  if (
    integrated !== -Infinity &&
    Number.isFinite(silenceRatio) &&
    silenceRatio > 0.995
  ) {
    report.problem(
      "silent-track",
      `静音占比 ${(silenceRatio * 100).toFixed(1)}%，成片近乎无声`,
    );
  }
  if (
    values["max-silence"] > 0 &&
    longest &&
    longest.duration > values["max-silence"]
  ) {
    report.problem(
      "long-silence",
      `最长静音段 ${formatSeconds(longest.duration)} 超过 ${values["max-silence"]}s`,
    );
  }
  if (!silence.sounding.length) {
    report.problem(
      "no-sounding",
      `全片没有超过 ${values["silence-duration"]}s 的发声段`,
    );
  }

  return report.emit();
});
