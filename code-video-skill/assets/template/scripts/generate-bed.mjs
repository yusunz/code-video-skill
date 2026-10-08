#!/usr/bin/env node
/**
 * 生成"无音频兜底 BGM"音床：把音效元素（节奏层 / 氛围层 / 点缀）按目标时长与
 * 节拍铺成一条完整的 BGM，保证用户没提供音乐时成片也不静音。
 *
 * 用法（在用户项目目录里）：
 *   npm run bed -- --duration=30
 *   npm run bed -- --duration=30 --analysis=out\audio-analysis.json --intensity=0.6
 *   npm run bed -- --duration=10 --transitions=5 --out=public/audio/bed/bed-10s.wav
 *
 * 链路与音效一致：esbuild 打包音效源码 → 无头 Chrome 里 Tone.Offline 合成 → WAV。
 * 产物直接 `staticFile("audio/bed/…")` 挂到 `<Audio>`；渲染期不做任何实时合成。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openBrowser } from "@remotion/renderer";

const run = promisify(execFile);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundlePath = path.join(projectRoot, "build/sfx-browser.js");
const manifestPath = path.join(projectRoot, "build/bed-manifest.json");

const DEFAULTS = {
  bpm: 120,
  intensity: 0.5,
  transitionEvery: 10,
  peakDb: -3,
  out: "public/audio/bed/bed.wav",
  levelsFps: 30,
};

const USAGE = `用法：node scripts/generate-bed.mjs --duration=<秒> [选项]

  --duration <秒>            目标时长（必填，成片多长就生成多长）
  --analysis <path>          可选：analyze-music.py 输出的 audio-analysis.json（有拍点就按拍点铺）
  --bpm <数值>               没有拍点数据时的固定 BPM（默认 ${DEFAULTS.bpm}）
  --intensity <0..1>         强度：越大越密越响（默认 ${DEFAULTS.intensity}）
  --transitions <a,b>        段落切换点（秒）：riser 提前抬起、impact 正好落下
  --transition-every <秒>    没给 --transitions 时的自动间隔（默认 ${DEFAULTS.transitionEvery}）
  --peak-db <dBFS>           归一化目标峰值（默认 ${DEFAULTS.peakDb}，给上层音效留余量）
  --out <path>               输出 WAV 路径（默认 ${DEFAULTS.out}）
  --mp3                      额外用 ffmpeg 转一份 192kbps MP3（试听用，成片一律挂 WAV）
  --json                     只输出一份 JSON（供工作流消费）`;

function parseArgv(argv) {
  const values = {};
  const flags = new Set();
  for (const token of argv) {
    if (!token.startsWith("--")) {
      throw new Error(`不认识的参数 "${token}"（--help 查看用法）`);
    }
    const equals = token.indexOf("=");
    const key = (equals === -1 ? token : token.slice(0, equals)).slice(2);
    const value = equals === -1 ? undefined : token.slice(equals + 1);
    if (value === undefined) flags.add(key);
    else values[key] = value;
  }
  return { values, flags };
}

function numberArg(values, key, fallback) {
  if (values[key] === undefined) return fallback;
  const parsed = Number(values[key]);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${key} 需要数值，收到 "${values[key]}"`);
  }
  return parsed;
}

/** 读 analyze-music.py 的产物；字段名与其输出约定一致。 */
async function readAnalysis(file) {
  const absolute = path.resolve(file);
  const parsed = JSON.parse(await readFile(absolute, "utf8"));
  const numbers = (value) =>
    Array.isArray(value)
      ? value.map(Number).filter((item) => Number.isFinite(item))
      : [];

  const levelsFps = Number(
    parsed.levels_fps ?? parsed.meta?.levels_fps ?? DEFAULTS.levelsFps,
  );

  return {
    path: absolute,
    bpm: Number(parsed.bpm) || DEFAULTS.bpm,
    beats: numbers(parsed.beats),
    downbeats: numbers(parsed.downbeats),
    levels: numbers(parsed.levels),
    levelsFps:
      Number.isFinite(levelsFps) && levelsFps > 0
        ? levelsFps
        : DEFAULTS.levelsFps,
  };
}

/** 没有拍点数据时用固定 BPM 的网格；编排层会按 duration 截断，这里不重复过滤。 */
const emptyGrid = (bpm) => ({
  bpm,
  beats: [],
  downbeats: [],
  levels: [],
  levelsFps: DEFAULTS.levelsFps,
});

const summary = (rendered, request) => [
  `时长        ${rendered.durationInSeconds.toFixed(6)}s（${rendered.samples} 样本 @ ${rendered.sampleRate}Hz）`,
  `BPM          ${rendered.plan.bpm.toFixed(2)}（拍距 ${rendered.plan.beatIntervalSeconds.toFixed(3)}s）`,
  `强度        ${rendered.plan.intensity.toFixed(2)}`,
  `节奏层      底鼓 ${rendered.plan.counts.kicks} · 滴答 ${rendered.plan.counts.ticks}`,
  `氛围层      垫音铺到 ${rendered.plan.padSustainedUntil.toFixed(3)}s，包络 ${Math.round(rendered.plan.padSustainedUntil * 10)} 点`,
  `点缀        riser ${rendered.plan.counts.risers} · impact ${rendered.plan.counts.impacts} · 收尾音 ${rendered.plan.counts.hasOutro ? "有" : "无"}`,
  `切换点      ${rendered.plan.transitions.map((at) => `${at.toFixed(3)}s`).join("、") || "无"}`,
  `峰值        ${rendered.peakDbBeforeNormalize.toFixed(2)} dBFS → 归一化到 ${rendered.peakDb} dBFS`,
  `请求        duration=${request.durationInSeconds}s · transitions=${request.transitions.length ? request.transitions.join(",") : "自动"}`,
];

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { values, flags } = parseArgv(process.argv.slice(2));
  const durationInSeconds = Number(values.duration);
  if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) {
    throw new Error(`--duration 必填且要大于 0（--help 查看用法）`);
  }

  const intensity = numberArg(values, "intensity", DEFAULTS.intensity);
  if (intensity < 0 || intensity > 1) {
    throw new Error(`--intensity 需要在 0~1 之间，收到 ${intensity}`);
  }

  const analysis = values.analysis ? await readAnalysis(values.analysis) : null;
  const bpm = analysis ? analysis.bpm : numberArg(values, "bpm", DEFAULTS.bpm);
  const transitions = (values.transitions ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  if (transitions.some((value) => !Number.isFinite(value))) {
    throw new Error(
      `--transitions 需要逗号分隔的秒数，收到 "${values.transitions}"`,
    );
  }

  const request = {
    durationInSeconds,
    intensity,
    transitions,
    transitionEverySeconds: numberArg(
      values,
      "transition-every",
      DEFAULTS.transitionEvery,
    ),
    peakDb: numberArg(values, "peak-db", DEFAULTS.peakDb),
    grid: analysis
      ? {
          bpm: analysis.bpm,
          beats: analysis.beats,
          downbeats: analysis.downbeats,
          levels: analysis.levels,
          levelsFps: analysis.levelsFps,
        }
      : emptyGrid(bpm),
  };

  const outPath = path.resolve(projectRoot, values.out ?? DEFAULTS.out);
  await mkdir(path.dirname(outPath), { recursive: true });

  const bundleSource = await readFile(bundlePath, "utf8");
  const sourceMapGetter = { getSourceMap: async () => null };
  const browser = await openBrowser("chrome", {
    chromeMode: "headless-shell",
    logLevel: "error",
  });

  let rendered;
  try {
    const page = await browser.newPage({
      context: sourceMapGetter,
      logLevel: "error",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => undefined,
    });

    await page.goto({ url: "about:blank", timeout: 30000 });
    await page.evaluate(bundleSource);

    const startedAt = Date.now();
    rendered = await page.evaluate(
      `window.AudioForge.renderBed(${JSON.stringify(request)})`,
    );
    const elapsedMs = Date.now() - startedAt;

    await page.close();
    await writeFile(outPath, Buffer.from(rendered.wavBase64, "base64"));

    const manifest = {
      generatedAt: new Date().toISOString(),
      runtime: "headless-chrome (Remotion Chrome Headless Shell)",
      source: analysis
        ? path.relative(projectRoot, analysis.path)
        : "fixed-bpm-grid",
      request,
      output: {
        path: path.relative(projectRoot, outPath).replaceAll("\\", "/"),
        bytes: rendered.bytes,
        samples: rendered.samples,
        sampleRate: rendered.sampleRate,
        durationInSeconds: rendered.durationInSeconds,
        peakDbBeforeNormalize: Number(
          rendered.peakDbBeforeNormalize.toFixed(3),
        ),
        peakDbTarget: rendered.peakDb,
        renderMs: elapsedMs,
      },
      plan: rendered.plan,
    };

    if (flags.has("mp3")) {
      const mp3Path = outPath.replace(/\.wav$/i, ".mp3");
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        outPath,
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        mp3Path,
      ]);
      manifest.output.mp3 = path
        .relative(projectRoot, mp3Path)
        .replaceAll("\\", "/");
    }

    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    if (flags.has("json")) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }

    console.log(`音床 → ${path.relative(projectRoot, outPath)}`);
    for (const line of summary(rendered, request)) {
      console.log(`  ${line}`);
    }
    console.log(
      `  体积        ${(rendered.bytes / 1024 / 1024).toFixed(2)} MiB · 合成 ${elapsedMs}ms`,
    );
    if (manifest.output.mp3)
      console.log(`  MP3         ${manifest.output.mp3}`);
    console.log(`  manifest    ${path.relative(projectRoot, manifestPath)}`);
  } finally {
    await browser.close({ silent: true });
  }
}

main().catch((error) => {
  process.stderr.write(`\n音床生成失败：${error?.message ?? error}\n`);
  process.exitCode = 1;
});
