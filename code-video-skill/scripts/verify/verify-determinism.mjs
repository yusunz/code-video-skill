#!/usr/bin/env node
/**
 * 帧级一致性比对：对两个成片的视频流取 framemd5（解码层逐帧哈希）再逐帧比对。
 *
 * 为什么不用 MP4 文件哈希：H.264 基本流在不同次渲染之间有 ±0.1% 的字节漂移，
 * 但解码后的像素帧完全一致——复现判据是帧级的（framemd5 / still SHA256）。
 *
 * 退出码：0 = 帧级一致；1 = 存在不一致；2 = 用法错误或环境问题。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  CliError,
  Report,
  assertFile,
  assertSuccess,
  describeTools,
  displayPath,
  formatBytes,
  parseArgs,
  readMediaInfo,
  resolveTools,
  runFfmpeg,
  runMain,
} from "./lib.mjs";

const TOOL = "verify-determinism";
const USAGE = "node scripts/verify/verify-determinism.mjs <mp4a> <mp4b> [选项]";

const SPEC = {
  json: { type: "boolean", help: "输出完整 JSON（stdout 只有 JSON）" },
  audio: { type: "boolean", help: "同时比对音频流（解码后的 PCM 帧）" },
  "list-limit": {
    type: "number",
    default: 5,
    valueHint: "N",
    help: "摘要与 JSON 里最多列出的差异帧条数",
  },
};

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * 解析 framemd5：
 *   #tb 0: 1/30           → meta.tb
 *   0, 0, 0, 1, 3110400, 3f2a…   → 每帧一行（stream, dts, pts, duration, size, hash）
 */
function parseFramemd5(text) {
  const meta = {};
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("#")) {
      const match = /^#([a-zA-Z_]+)(?:\s+\d+)?\s*:\s*(.+)$/.exec(line);
      if (match) meta[match[1]] = match[2].trim();
      continue;
    }
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 6) continue;
    frames.push({
      stream: Number(parts[0]),
      dts: Number(parts[1]),
      pts: Number(parts[2]),
      duration: Number(parts[3]),
      size: Number(parts[4]),
      hash: parts[5],
    });
  }
  return { meta, frames };
}

/** 对指定轨道取解码帧哈希（framemd5 是解码结果，不是容器字节）。 */
async function framemd5(file, map) {
  const result = await runFfmpeg([
    "-v",
    "error",
    "-i",
    file,
    "-map",
    map,
    "-f",
    "framemd5",
    "-",
  ]);
  assertSuccess(result, `framemd5（${map}）`);
  const parsed = parseFramemd5(result.stdout);
  if (!parsed.frames.length) {
    throw new CliError(`framemd5（${map}）没有输出任何帧：${displayPath(file)}`);
  }
  return parsed;
}

/** 逐帧比对：按帧序对齐，同时统计 pts 漂移。 */
function compareFrames(a, b) {
  const mismatches = [];
  const shared = Math.min(a.length, b.length);
  let ptsMismatches = 0;
  for (let index = 0; index < shared; index += 1) {
    if (a[index].hash !== b[index].hash) {
      mismatches.push({ index, a: a[index], b: b[index] });
    }
    if (a[index].pts !== b[index].pts) ptsMismatches += 1;
  }
  return {
    shared,
    hashMismatches: mismatches,
    ptsMismatches,
    countMismatch: a.length !== b.length,
  };
}

function framesToRows(label, a, b, comparison, listLimit) {
  const rows = [
    ["帧数", `${a.length} ↔ ${b.length}`, comparison.countMismatch ? "warn" : "ok"],
    [
      `${label}哈希`,
      comparison.hashMismatches.length === 0 && !comparison.countMismatch
        ? `全部一致（${comparison.shared} 帧）`
        : `${comparison.hashMismatches.length} 帧不同（共比对 ${comparison.shared} 帧）`,
      comparison.hashMismatches.length || comparison.countMismatch ? "warn" : "ok",
    ],
    [
      "时间戳（pts）",
      comparison.ptsMismatches === 0
        ? "逐帧一致"
        : `${comparison.ptsMismatches} 帧 pts 不同（时间轴漂移）`,
      comparison.ptsMismatches ? "warn" : "ok",
    ],
  ];
  for (const mismatch of comparison.hashMismatches.slice(0, listLimit)) {
    rows.push([
      `第 ${mismatch.index} 帧`,
      `${mismatch.a.hash.slice(0, 12)}… ≠ ${mismatch.b.hash.slice(0, 12)}…`,
      "warn",
    ]);
  }
  if (comparison.hashMismatches.length > listLimit) {
    rows.push(["…", `还有 ${comparison.hashMismatches.length - listLimit} 帧不同（见 --json）`]);
  }
  return rows;
}

runMain(async () => {
  const { values, positionals } = parseArgs(process.argv.slice(2), SPEC, {
    tool: TOOL,
    usage: USAGE,
    description: "帧级一致性比对（framemd5，解码层）",
  });
  if (positionals.length !== 2) {
    throw new CliError(`需要两个成片路径（收到 ${positionals.length} 个，--help 查看用法）`);
  }

  const fileA = assertFile(positionals[0], "成片 A");
  const fileB = assertFile(positionals[1], "成片 B");
  const tools = await resolveTools();
  const report = new Report(TOOL, {
    json: values.json,
    subjects: [displayPath(fileA.path), displayPath(fileB.path)],
  });
  report.note(describeTools(tools));
  report.note("判据是解码帧（framemd5）；MP4 文件哈希只作记录，编码字节漂移是已知现象。");

  const infoA = await readMediaInfo(fileA.path);
  const infoB = await readMediaInfo(fileB.path);
  if (!infoA.video || !infoB.video) {
    throw new CliError(
      `${!infoA.video ? displayPath(fileA.path) : displayPath(fileB.path)} 里没有视频流，无法做帧级比对`,
    );
  }

  const videoA = await framemd5(fileA.path, "0:v:0");
  const videoB = await framemd5(fileB.path, "0:v:0");
  const videoComparison = compareFrames(videoA.frames, videoB.frames);

  report.section("视频流", [
    ["尺寸", `${videoA.meta.dimensions ?? "?"} ↔ ${videoB.meta.dimensions ?? "?"}`],
    ["时基", `${videoA.meta.tb ?? "?"} ↔ ${videoB.meta.tb ?? "?"}`],
    ...framesToRows("帧", videoA.frames, videoB.frames, videoComparison, values["list-limit"]),
  ]);

  let audioComparison = null;
  let audioFrameCounts = null;
  if (values.audio) {
    if (!infoA.audio || !infoB.audio) {
      report.problem(
        "no-audio-stream",
        `--audio 要求两边都有音频流（A：${infoA.audio ? "有" : "无"}，B：${infoB.audio ? "有" : "无"}）`,
      );
    } else {
      const audioA = await framemd5(fileA.path, "0:a:0");
      const audioB = await framemd5(fileB.path, "0:a:0");
      audioComparison = compareFrames(audioA.frames, audioB.frames);
      audioFrameCounts = { a: audioA.frames.length, b: audioB.frames.length };
      report.section("音频流", [
        [
          "参数",
          `${audioA.meta.sample_rate ?? "?"} Hz / ${audioA.meta.channel_layout_name ?? "?"} ↔ ` +
            `${audioB.meta.sample_rate ?? "?"} Hz / ${audioB.meta.channel_layout_name ?? "?"}`,
        ],
        ...framesToRows("PCM", audioA.frames, audioB.frames, audioComparison, values["list-limit"]),
      ]);
    }
  }

  const sizes = `${formatBytes(fileA.sizeBytes)} ↔ ${formatBytes(fileB.sizeBytes)}`;
  const hashes = [await sha256(fileA.path), await sha256(fileB.path)];
  report.section("文件（仅记录）", [
    ["大小", sizes],
    [
      "SHA256",
      hashes[0] === hashes[1]
        ? `${hashes[0].slice(0, 16)}…（相同）`
        : `${hashes[0].slice(0, 12)}… ≠ ${hashes[1].slice(0, 12)}…（字节漂移，不作判据）`,
    ],
  ]);

  report.data({
    files: [
      { path: fileA.path, sizeBytes: fileA.sizeBytes, sha256: hashes[0] },
      { path: fileB.path, sizeBytes: fileB.sizeBytes, sha256: hashes[1] },
    ],
    video: {
      meta: { a: videoA.meta, b: videoB.meta },
      frameCount: { a: videoA.frames.length, b: videoB.frames.length },
      hashMismatchCount: videoComparison.hashMismatches.length,
      ptsMismatchCount: videoComparison.ptsMismatches,
      firstMismatches: videoComparison.hashMismatches
        .slice(0, values["list-limit"])
        .map((mismatch) => ({
          index: mismatch.index,
          a: { pts: mismatch.a.pts, hash: mismatch.a.hash },
          b: { pts: mismatch.b.pts, hash: mismatch.b.hash },
        })),
    },
    audio: audioComparison
      ? {
          hashMismatchCount: audioComparison.hashMismatches.length,
          ptsMismatchCount: audioComparison.ptsMismatches,
          frameCount: audioFrameCounts,
        }
      : null,
    fileHashEqual: hashes[0] === hashes[1],
  });

  /* ── 告警汇总 ── */
  for (const [name, metaA, metaB] of [
    ["尺寸", videoA.meta.dimensions, videoB.meta.dimensions],
    ["时基", videoA.meta.tb, videoB.meta.tb],
  ]) {
    if (metaA !== metaB) {
      report.problem("structure", `${name}不同：${metaA} ↔ ${metaB}`);
    }
  }
  if (videoComparison.countMismatch) {
    report.problem(
      "frame-count",
      `视频帧数不同：${videoA.frames.length} ↔ ${videoB.frames.length}`,
    );
  }
  if (videoComparison.hashMismatches.length) {
    report.problem(
      "video-frames",
      `视频有 ${videoComparison.hashMismatches.length}/${videoComparison.shared} 帧解码像素不同` +
        `（首个不同：第 ${videoComparison.hashMismatches[0].index} 帧）`,
    );
  }
  if (videoComparison.ptsMismatches) {
    report.problem(
      "video-pts",
      `视频有 ${videoComparison.ptsMismatches} 帧时间戳不同（画面一致但时间轴漂移）`,
    );
  }
  if (audioComparison?.countMismatch) {
    report.problem("audio-count", "音频 PCM 帧数不同");
  }
  if (audioComparison?.hashMismatches.length) {
    report.problem(
      "audio-frames",
      `音频有 ${audioComparison.hashMismatches.length}/${audioComparison.shared} 帧 PCM 不同`,
    );
  }
  if (audioComparison?.ptsMismatches) {
    report.problem("audio-pts", `音频有 ${audioComparison.ptsMismatches} 帧时间戳不同`);
  }

  return report.emit();
});
