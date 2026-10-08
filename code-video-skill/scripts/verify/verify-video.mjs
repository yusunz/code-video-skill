#!/usr/bin/env node
/**
 * 成片体检：规格（分辨率 / 帧率 / 编码 / 像素格式 / 色彩 / 容器时长）
 *          + 实际解码帧数（ffprobe -count_frames）
 *          + 逐帧亮度（signalstats YAVG，黑帧与闪烁扫描）
 *          + 编码参数（x264 SEI 里的 crf，用于核对渲染基线）
 *
 * 退出码：0 = 通过；1 = 有告警；2 = 用法错误或环境问题。
 */
import {
  CliError,
  Report,
  assertFile,
  assertSuccess,
  describeTools,
  displayPath,
  formatBitRate,
  formatBytes,
  formatFps,
  formatNumber,
  formatSeconds,
  parseArgs,
  readMediaInfo,
  resolveTools,
  runFfmpeg,
  runMain,
} from "./lib.mjs";

const TOOL = "verify-video";
const USAGE = "node scripts/verify/verify-video.mjs <mp4> [选项]";

const SPEC = {
  json: { type: "boolean", help: "输出完整 JSON（stdout 只有 JSON）" },
  "black-threshold": {
    type: "number",
    default: 20,
    valueHint: "0-255",
    help: "黑帧判定阈值：YAVG ≤ 该值即告警（有限范围视频的纯黑是 16）",
  },
  "flicker-delta": {
    type: "number",
    default: 0,
    valueHint: "0-255",
    help: "相邻帧亮度跳变告警阈值；0 = 只记录不告警",
  },
  "list-limit": {
    type: "number",
    default: 10,
    valueHint: "N",
    help: "摘要与 JSON 里最多列出的告警帧条数",
  },
  "expect-pix-fmt": {
    type: "string",
    default: "yuv420p",
    valueHint: "格式",
    help: "期望像素格式；any = 不检查（基线要求 yuv420p，yuvj420p 是全范围陷阱）",
  },
  "expect-color": {
    type: "string",
    default: "bt709",
    valueHint: "标准",
    help: "期望色彩标注；any = 不检查",
  },
  "expect-range": {
    type: "string",
    default: "tv",
    valueHint: "tv|pc|any",
    help: "期望色彩范围；any = 不检查（未标注时只备注）",
  },
  "expect-width": { type: "number", valueHint: "px", help: "期望宽度，例如 1920" },
  "expect-height": { type: "number", valueHint: "px", help: "期望高度，例如 1080" },
  "expect-fps": { type: "number", valueHint: "fps", help: "期望帧率，例如 30" },
  "expect-frames": { type: "number", valueHint: "N", help: "期望总帧数，例如 300" },
  "expect-duration": { type: "number", valueHint: "秒", help: "期望容器时长，例如 10" },
  "expect-crf": { type: "number", valueHint: "N", help: "期望 x264 CRF；不传则只报告" },
  "duration-tolerance": {
    type: "number",
    default: 0.002,
    valueHint: "秒",
    help: "容器时长与视频流时长的允许偏差（AAC 补齐会多出约 5ms）",
  },
};

/** 从 trace_headers 的输出里把 x264 的 SEI user data 拼回文本。 */
function parseSeiText(stderr) {
  const bytes = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = /user_data_payload_byte\[\s*\d+\]\s+[01]+\s*=\s*(\d+)/.exec(line);
    if (match) bytes.push(Number(match[1]));
  }
  return bytes.length ? Buffer.from(bytes).toString("utf8") : "";
}

/**
 * 读编码参数：先用 filter_units 只留 SEI NAL（pass_types=6），再用 trace_headers 打印字节。
 * x264 会把 `rc=crf crf=18.0 …` 写进 SEI，是核对"是否走了渲染基线"的直接证据。
 */
async function readEncoderOptions(file) {
  const result = await runFfmpeg([
    "-i",
    file,
    "-map",
    "0:v:0",
    "-c",
    "copy",
    "-bsf:v",
    "filter_units=pass_types=6,trace_headers",
    "-frames:v",
    "3",
    "-f",
    "null",
    "-",
  ]);
  if (result.code !== 0) return null;
  const text = parseSeiText(result.stderr);
  const options = /-\s*options:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!options) return null;
  return {
    encoder: /^x264 - core \S+ \S+/.exec(text)?.[0] ?? null,
    options,
    crf: Number(/\bcrf=([\d.]+)/.exec(options)?.[1] ?? NaN),
  };
}

/** 解析 `metadata=print` 的输出；每个 YAVG 值都带帧号与时间。 */
function parseYavgSamples(stderr) {
  const samples = [];
  let current = null;
  for (const line of stderr.split(/\r?\n/)) {
    const frame = /frame:(\d+)\s+pts:(-?\d+)\s+pts_time:(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (frame) {
      current = {
        index: Number(frame[1]),
        pts: Number(frame[2]),
        seconds: Number(frame[3]),
      };
      continue;
    }
    const yavg = /lavfi\.signalstats\.YAVG=(-?[\d.]+)/.exec(line);
    if (yavg && current) {
      samples.push({ ...current, yavg: Number(yavg[1]) });
      current = null;
    }
  }
  return samples;
}

/** 全片逐帧亮度扫描（解码层面，不受编码字节漂移影响）。 */
async function scanLuminance(file) {
  const result = await runFfmpeg([
    "-i",
    file,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f",
    "null",
    "-",
  ]);
  assertSuccess(result, "逐帧亮度扫描（signalstats）");
  const samples = parseYavgSamples(result.stderr);
  if (!samples.length) {
    throw new CliError("逐帧亮度扫描没有取到任何帧，请确认文件里有可解码的视频流");
  }
  return samples;
}

/** 统计最值、黑帧区间与最大跳变。 */
function summarizeLuminance(samples, threshold) {
  const values = samples.map((sample) => sample.yavg);
  let minSample = samples[0];
  let maxSample = samples[0];
  let maxJump = null;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    sum += sample.yavg;
    if (sample.yavg < minSample.yavg) minSample = sample;
    if (sample.yavg > maxSample.yavg) maxSample = sample;
    if (index > 0) {
      const previous = samples[index - 1];
      const delta = Math.abs(sample.yavg - previous.yavg);
      if (!maxJump || delta > maxJump.delta) {
        maxJump = {
          frame: sample.index,
          seconds: sample.seconds,
          from: previous.yavg,
          to: sample.yavg,
          delta,
        };
      }
    }
  }

  const alerts = samples.filter((sample) => sample.yavg <= threshold);
  const runs = [];
  for (const alert of alerts) {
    const last = runs[runs.length - 1];
    if (last && alert.index === last.endFrame + 1) {
      last.endFrame = alert.index;
      last.endSeconds = alert.seconds;
      last.count += 1;
    } else {
      runs.push({
        startFrame: alert.index,
        endFrame: alert.index,
        startSeconds: alert.seconds,
        endSeconds: alert.seconds,
        count: 1,
      });
    }
  }

  return {
    frameCount: samples.length,
    average: sum / samples.length,
    min: { frame: minSample.index, seconds: minSample.seconds, value: minSample.yavg },
    max: { frame: maxSample.index, seconds: maxSample.seconds, value: maxSample.yavg },
    threshold,
    alertFrameCount: alerts.length,
    alertRuns: runs,
    alerts,
    maxJump,
  };
}

runMain(async () => {
  const { values, positionals } = parseArgs(process.argv.slice(2), SPEC, {
    tool: TOOL,
    usage: USAGE,
    description: "成片体检：规格 / 解码帧数 / 逐帧亮度（黑帧）/ 编码参数",
  });
  if (positionals.length !== 1) {
    throw new CliError(`需要且只需要一个成片路径（收到 ${positionals.length} 个，--help 查看用法）`);
  }

  const file = assertFile(positionals[0], "成片");
  const tools = await resolveTools();
  const report = new Report(TOOL, {
    json: values.json,
    subjects: [displayPath(file.path)],
  });
  report.note(describeTools(tools));

  /* ── 规格 ── */
  const info = await readMediaInfo(file.path, { countFrames: true });
  const { video, audio, format } = info;
  if (!video) {
    report.problem("no-video-stream", "文件里没有视频流，无法体检");
    return report.emit();
  }

  const containerDuration = Number(format.duration);
  const videoDuration = Number(video.duration);
  const declaredFrames = Number(video.nb_frames);
  const decodedFrames = Number(video.nb_read_frames);

  report.section("容器", [
    ["路径", displayPath(file.path)],
    ["大小", formatBytes(file.sizeBytes)],
    ["封装", format.format_name ?? "未知"],
    ["容器时长", formatSeconds(containerDuration)],
    ["总码率", formatBitRate(format.bit_rate)],
    [
      "轨道",
      `视频 ${info.streams.filter((s) => s.codec_type === "video").length} · ` +
        `音频 ${info.streams.filter((s) => s.codec_type === "audio").length} · ` +
        `其他 ${info.streams.filter((s) => !["video", "audio"].includes(s.codec_type)).length}`,
    ],
  ]);

  const colorTags = [video.color_space, video.color_primaries, video.color_transfer].map(
    (tag) => tag ?? "未标注",
  );
  const colorMismatch =
    values["expect-color"] !== "any" &&
    colorTags.some((tag) => tag !== values["expect-color"]);
  const rangeTag = video.color_range ?? null;
  const rangeMismatch =
    values["expect-range"] !== "any" &&
    rangeTag !== null &&
    rangeTag !== values["expect-range"];

  const streamRows = [
    ["编码", `${video.codec_name ?? "未知"}${video.profile ? ` (${video.profile})` : ""}`],
    ["分辨率", `${video.width}×${video.height}`],
    ["帧率", formatFps(video.r_frame_rate)],
    [
      "像素格式",
      video.pix_fmt ?? "未知",
      values["expect-pix-fmt"] !== "any" && video.pix_fmt !== values["expect-pix-fmt"]
        ? "warn"
        : undefined,
    ],
    ["色彩标注", colorTags.join(" / "), colorMismatch ? "warn" : undefined],
    ["色彩范围", rangeTag ?? "未标注", rangeMismatch ? "warn" : undefined],
    ["声明帧数", Number.isFinite(declaredFrames) ? `${declaredFrames}` : "未声明"],
    [
      "解码帧数",
      Number.isFinite(decodedFrames) ? `${decodedFrames}` : "未知",
      Number.isFinite(declaredFrames) && decodedFrames !== declaredFrames ? "warn" : undefined,
    ],
    ["视频流时长", formatSeconds(videoDuration)],
    ["视频码率", formatBitRate(video.bit_rate ?? format.bit_rate)],
  ];
  if (audio) {
    streamRows.push([
      "音频流",
      `${audio.codec_name ?? "未知"} · ${audio.sample_rate ?? "?"} Hz · ` +
        `${audio.channels ?? "?"}ch · ${formatBitRate(audio.bit_rate)}`,
    ]);
  } else {
    streamRows.push(["音频流", "无（静音成片）"]);
  }
  report.section("视频流", streamRows);

  /* ── 编码参数（CRF）── */
  const encoderOptions = await readEncoderOptions(file.path);
  const crf = Number.isFinite(encoderOptions?.crf) ? encoderOptions.crf : null;
  report.section("编码参数", [
    ["编码器", encoderOptions?.encoder ?? "未读到 SEI（非 x264 或已剥离）"],
    [
      "CRF",
      crf === null ? "未知" : formatNumber(crf, 1),
      values["expect-crf"] !== undefined && crf !== values["expect-crf"] ? "warn" : undefined,
    ],
  ]);

  /* ── 逐帧亮度 ── */
  const luminance = summarizeLuminance(await scanLuminance(file.path), values["black-threshold"]);
  const listedAlerts = luminance.alerts.slice(0, values["list-limit"]);
  report.section(`逐帧亮度 YAVG（${luminance.frameCount} 帧）`, [
    [
      "最低",
      `${formatNumber(luminance.min.value)} · 帧 ${luminance.min.frame} @ ${formatSeconds(luminance.min.seconds)}`,
      luminance.alertFrameCount > 0 ? "warn" : "ok",
    ],
    ["最高", `${formatNumber(luminance.max.value)} · 帧 ${luminance.max.frame} @ ${formatSeconds(luminance.max.seconds)}`],
    ["平均", formatNumber(luminance.average)],
    [
      "黑帧",
      luminance.alertFrameCount === 0
        ? `无（阈值 ${luminance.threshold}）`
        : `${luminance.alertFrameCount} 帧 / ${luminance.alertRuns.length} 段（阈值 ${luminance.threshold}）`,
      luminance.alertFrameCount > 0 ? "warn" : "ok",
    ],
    [
      "最大跳变",
      luminance.maxJump
        ? `${formatNumber(luminance.maxJump.delta)} · 帧 ${luminance.maxJump.frame}（${formatNumber(luminance.maxJump.from)} → ${formatNumber(luminance.maxJump.to)}）`
        : "样本不足",
    ],
  ]);
  if (listedAlerts.length) {
    report.note(
      `告警帧：${listedAlerts
        .map((sample) => `#${sample.index}@${formatSeconds(sample.seconds)} YAVG=${formatNumber(sample.yavg)}`)
        .join("，")}${luminance.alerts.length > listedAlerts.length ? ` …（共 ${luminance.alerts.length} 帧）` : ""}`,
    );
  }

  report.data({
    file: { path: file.path, sizeBytes: file.sizeBytes },
    container: format,
    streams: info.streams,
    spec: {
      expected: {
        pixFmt: values["expect-pix-fmt"],
        color: values["expect-color"],
        range: values["expect-range"],
        width: values["expect-width"] ?? null,
        height: values["expect-height"] ?? null,
        fps: values["expect-fps"] ?? null,
        frames: values["expect-frames"] ?? null,
        duration: values["expect-duration"] ?? null,
        crf: values["expect-crf"] ?? null,
      },
      width: video.width,
      height: video.height,
      fps: video.r_frame_rate,
      pixFmt: video.pix_fmt ?? null,
      colorSpace: video.color_space ?? null,
      colorPrimaries: video.color_primaries ?? null,
      colorTransfer: video.color_transfer ?? null,
      colorRange: rangeTag,
      declaredFrames: Number.isFinite(declaredFrames) ? declaredFrames : null,
      decodedFrames: Number.isFinite(decodedFrames) ? decodedFrames : null,
      videoDuration: Number.isFinite(videoDuration) ? videoDuration : null,
      containerDuration: Number.isFinite(containerDuration) ? containerDuration : null,
    },
    encoder: encoderOptions ? { ...encoderOptions, crf } : null,
    luminance: {
      frameCount: luminance.frameCount,
      average: luminance.average,
      min: luminance.min,
      max: luminance.max,
      threshold: luminance.threshold,
      alertFrameCount: luminance.alertFrameCount,
      alertRuns: luminance.alertRuns,
      alertFrames: listedAlerts,
      alertFramesTruncated: luminance.alerts.length > listedAlerts.length,
      maxJump: luminance.maxJump,
    },
  });

  /* ── 告警汇总 ── */
  if (values["expect-pix-fmt"] !== "any" && video.pix_fmt !== values["expect-pix-fmt"]) {
    report.problem(
      "pix-fmt",
      `像素格式是 ${video.pix_fmt}，期望 ${values["expect-pix-fmt"]}（全范围 yuvj 系会改变色彩解释）`,
    );
  }
  if (colorMismatch) {
    report.problem(
      "color-tags",
      `色彩标注 ${colorTags.join(" / ")}，期望全部为 ${values["expect-color"]}`,
    );
  }
  if (rangeMismatch) {
    report.problem("color-range", `色彩范围是 ${rangeTag}，期望 ${values["expect-range"]}`);
  }
  if (
    Number.isFinite(containerDuration) &&
    Number.isFinite(videoDuration) &&
    Math.abs(containerDuration - videoDuration) > values["duration-tolerance"]
  ) {
    report.problem(
      "duration-drift",
      `容器时长 ${formatSeconds(containerDuration)} 与视频流时长 ${formatSeconds(videoDuration)} ` +
        `相差超过 ${values["duration-tolerance"]}s（AAC 补齐的典型症状是 +5ms，需跑 finalize）`,
    );
  }
  if (Number.isFinite(declaredFrames) && decodedFrames !== declaredFrames) {
    report.problem(
      "frame-count",
      `容器声明 ${declaredFrames} 帧，实际解码 ${decodedFrames} 帧`,
    );
  }
  if (Number.isFinite(decodedFrames) && decodedFrames !== luminance.frameCount) {
    report.problem(
      "frame-count-scan",
      `count_frames 得到 ${decodedFrames} 帧，YAVG 扫描到 ${luminance.frameCount} 帧，两者不一致`,
    );
  }
  if (
    values["expect-crf"] !== undefined &&
    crf !== null &&
    Math.abs(crf - values["expect-crf"]) > 0.05
  ) {
    report.problem("crf", `CRF 是 ${formatNumber(crf, 1)}，期望 ${values["expect-crf"]}`);
  }
  if (values["expect-crf"] !== undefined && crf === null) {
    report.problem("crf-missing", `没有读到 x264 的 SEI，无法核对期望 CRF ${values["expect-crf"]}`);
  }
  for (const [key, actual] of [
    ["expect-width", video.width],
    ["expect-height", video.height],
  ]) {
    if (values[key] !== undefined && actual !== values[key]) {
      report.problem(key, `${key.replace("expect-", "").toUpperCase()} 是 ${actual}，期望 ${values[key]}`);
    }
  }
  if (values["expect-fps"] !== undefined) {
    const [numerator, denominator] = String(video.r_frame_rate ?? "").split("/").map(Number);
    const fps = denominator ? numerator / denominator : NaN;
    if (!Number.isFinite(fps) || Math.abs(fps - values["expect-fps"]) > 0.005) {
      report.problem("expect-fps", `帧率是 ${formatFps(video.r_frame_rate)}，期望 ${values["expect-fps"]} fps`);
    }
  }
  if (values["expect-frames"] !== undefined && decodedFrames !== values["expect-frames"]) {
    report.problem("expect-frames", `总帧数是 ${decodedFrames}，期望 ${values["expect-frames"]}`);
  }
  if (
    values["expect-duration"] !== undefined &&
    Math.abs(containerDuration - values["expect-duration"]) > values["duration-tolerance"]
  ) {
    report.problem(
      "expect-duration",
      `容器时长是 ${formatSeconds(containerDuration)}，期望 ${formatSeconds(values["expect-duration"])}`,
    );
  }
  if (luminance.alertFrameCount > 0) {
    const runs = luminance.alertRuns
      .slice(0, values["list-limit"])
      .map((run) =>
        run.count === 1
          ? `帧 ${run.startFrame}@${formatSeconds(run.startSeconds)}`
          : `帧 ${run.startFrame}-${run.endFrame}（${run.count} 帧，${formatSeconds(run.startSeconds)}→${formatSeconds(run.endSeconds)}）`,
      )
      .join("；");
    report.problem(
      "black-frames",
      `${luminance.alertFrameCount} 帧亮度 ≤ ${luminance.threshold}：${runs}`,
    );
  }
  if (
    values["flicker-delta"] > 0 &&
    luminance.maxJump &&
    luminance.maxJump.delta > values["flicker-delta"]
  ) {
    report.problem(
      "flicker",
      `帧 ${luminance.maxJump.frame} 亮度跳变 ${formatNumber(luminance.maxJump.delta)}，` +
        `超过阈值 ${values["flicker-delta"]}`,
    );
  }

  return report.emit();
});
