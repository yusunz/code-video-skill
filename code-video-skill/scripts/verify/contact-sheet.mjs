#!/usr/bin/env node
/**
 * 等间隔抽帧拼图：把成片按均匀间隔抽 N 帧，缩放后排成 M 列的网格 PNG。
 * 用途：一条命令肉眼确认段落是否齐全、画面是否跑飞、黑帧 / 空帧是否出现。
 *
 * 默认抽 12 帧、4 列（3 行），首帧与末帧一定包含在内；
 * 需要指定关键帧时用 `--at 0,20,104,240`（按给定顺序摆放）。
 *
 * 退出码：0 = 通过；1 = 有告警；2 = 用法错误或环境问题。
 */
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  CliError,
  Report,
  assertFile,
  assertSuccess,
  describeTools,
  displayPath,
  formatBytes,
  formatFps,
  formatSeconds,
  parseArgs,
  readMediaInfo,
  resolveTools,
  runFfmpeg,
  runFfprobe,
  runMain,
} from "./lib.mjs";

const TOOL = "contact-sheet";
const USAGE = "node scripts/verify/contact-sheet.mjs <mp4> <out.png> [--frames N --cols M]";

const SPEC = {
  frames: { type: "number", default: 12, valueHint: "N", help: "等间隔抽取的帧数" },
  cols: { type: "number", default: 4, valueHint: "M", help: "网格列数（行数由帧数推导）" },
  "thumb-width": {
    type: "number",
    default: 480,
    valueHint: "px",
    help: "每格宽度，高度按原片比例换算",
  },
  at: {
    type: "list",
    item: "number",
    valueHint: "0,20,104",
    help: "指定帧号（逗号分隔，按给定顺序摆放）；给了就忽略 --frames",
  },
  json: { type: "boolean", help: "输出完整 JSON（stdout 只有 JSON）" },
};

/** 等间隔帧号：首末帧一定在内；只有 1 帧时取中间帧。 */
function evenlySpacedFrames(total, count) {
  if (count === 1) return [Math.floor((total - 1) / 2)];
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(Math.round((index * (total - 1)) / (count - 1)));
  }
  return frames;
}

runMain(async () => {
  const { values, positionals } = parseArgs(process.argv.slice(2), SPEC, {
    tool: TOOL,
    usage: USAGE,
    description: "等间隔抽帧拼图（肉眼质检）",
  });
  if (positionals.length !== 2) {
    throw new CliError(
      `需要一个成片路径和一个 PNG 输出路径（收到 ${positionals.length} 个，--help 查看用法）`,
    );
  }
  for (const [name, minimum] of [
    ["frames", 1],
    ["cols", 1],
    ["thumb-width", 16],
  ]) {
    if (!(values[name] >= minimum)) {
      throw new CliError(`--${name} 至少是 ${minimum}，收到 ${values[name]}`);
    }
  }

  const input = assertFile(positionals[0], "成片");
  const output = path.resolve(positionals[1]);
  if (path.extname(output).toLowerCase() !== ".png") {
    throw new CliError(`输出必须是 .png（收到 ${path.basename(output)}）`);
  }
  if (output === input.path) throw new CliError("输出路径不能和输入文件相同");
  mkdirSync(path.dirname(output), { recursive: true });

  const tools = await resolveTools();
  const report = new Report(TOOL, {
    json: values.json,
    subjects: [displayPath(input.path), displayPath(output)],
  });
  report.note(describeTools(tools));

  const info = await readMediaInfo(input.path, { countFrames: true });
  if (!info.video) throw new CliError(`${displayPath(input.path)} 里没有视频流`);
  const totalFrames = Number(info.video.nb_read_frames ?? info.video.nb_frames);
  if (!Number.isFinite(totalFrames) || totalFrames < 1) {
    throw new CliError("无法确定成片的总帧数（ffprobe 没有给出 nb_read_frames）");
  }

  const explicit = values.at && values.at.length ? values.at : null;
  let frames;
  const notes = [];
  if (explicit) {
    const outOfRange = explicit.filter((frame) => frame < 0 || frame > totalFrames - 1);
    if (outOfRange.length) {
      throw new CliError(
        `--at 里的帧号超出范围 0~${totalFrames - 1}：${outOfRange.join(", ")}`,
      );
    }
    frames = explicit.map((frame) => Math.round(frame));
  } else {
    const count = Math.min(values.frames, totalFrames);
    if (count < values.frames) {
      notes.push(`成片只有 ${totalFrames} 帧，抽帧数从 ${values.frames} 收到 ${count}`);
    }
    frames = evenlySpacedFrames(totalFrames, count);
  }

  const cols = Math.min(values.cols, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const thumbWidth = Math.round(values["thumb-width"]);
  // 整个滤镜串作为单个 argv 传入，不需要 shell 层的转义；逗号写在引号内即可。
  const selectExpression = frames.map((frame) => `eq(n,${frame})`).join("+");
  const filter = [
    `select='${selectExpression}'`,
    `scale=${thumbWidth}:-2:flags=lanczos`,
    "setsar=1",
    "format=rgb24",
    `tile=${cols}x${rows}:nb_frames=${frames.length}`,
  ].join(",");

  const result = await runFfmpeg([
    "-y",
    "-i",
    input.path,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-update",
    "1",
    "-fps_mode",
    "passthrough",
    output,
  ]);
  assertSuccess(result, "抽帧拼图（tile）");

  const sheet = await runFfprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    output,
  ]);
  assertSuccess(sheet, `读取拼图 ${displayPath(output)}`);
  const sheetSize = JSON.parse(sheet.stdout).streams?.[0] ?? {};
  const outputSize = statSync(output).size;

  report.section("输入", [
    ["路径", displayPath(input.path)],
    ["总帧数", `${totalFrames}`],
    ["帧率", formatFps(info.video.r_frame_rate)],
    ["时长", formatSeconds(Number(info.format.duration))],
  ]);
  report.section("拼图", [
    ["抽帧", `${frames.length} 帧`],
    ["网格", `${cols} 列 × ${rows} 行`],
    ["每格", `${thumbWidth}px 宽`],
    ["画布", `${sheetSize.width ?? "?"}×${sheetSize.height ?? "?"}`],
    ["输出", `${displayPath(output)} · ${formatBytes(outputSize)}`],
  ]);
  report.note(
    `抽样帧号（按格从左到右、从上到下）：${frames.join(", ")}` +
      (frames.length < rows * cols ? `；末行空位 ${rows * cols - frames.length} 格为黑` : ""),
  );
  for (const note of notes) report.note(note);

  report.data({
    input: { path: input.path, sizeBytes: input.sizeBytes, totalFrames },
    output: {
      path: output,
      sizeBytes: outputSize,
      width: sheetSize.width ?? null,
      height: sheetSize.height ?? null,
    },
    grid: { cols, rows, thumbWidth, frames },
    filter,
  });

  if (frames.length < values.frames && !explicit) {
    report.problem("frame-shortage", `成片只有 ${totalFrames} 帧，少于要求的 ${values.frames} 帧`);
  }
  if (!outputSize) {
    report.problem("empty-output", "拼图文件是空的");
  }

  return report.emit();
});
