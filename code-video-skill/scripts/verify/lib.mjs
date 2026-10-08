#!/usr/bin/env node
/**
 * scripts/verify/lib.mjs —— 质检脚本公共库（只用 Node 内置模块，不引入 npm 依赖）
 *
 * 四块职责：
 *   1. ffmpeg / ffprobe 定位：标准 PATH 查找；失败时报出可操作的指引
 *      （环境问题由用户侧解决：只做标准 PATH 查找，不读取特定环境变量或注册表）；
 *   2. 子进程封装：spawn 捕获 stdout / stderr，保留退出码与耗时，提供 ffprobe JSON 读取；
 *   3. 参数解析：`--key value` / `--key=value` / 布尔开关，`--help` 自动生成；
 *   4. 输出格式化：终端摘要（Report）与 `--json` 结构化结果。
 *
 * 退出码约定（四个质检脚本统一）：
 *   0 = 通过；1 = 有告警（质检不通过）；2 = 用法错误或环境问题（找不到 ffmpeg、文件不存在等）。
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

/* ─────────────────────────────── 退出码 ─────────────────────────────── */

export const EXIT = Object.freeze({
  PASS: 0,
  ISSUE: 1,
  ERROR: 2,
});

/** 用法错误 / 环境问题：统一走退出码 2。 */
export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

/** `--help` 的内部信号：顶层捕获后退 0，不算错误。 */
export class HelpRequested extends Error {
  constructor() {
    super("help");
    this.name = "HelpRequested";
  }
}

/* ─────────────────────────────── 终端样式与宽度 ─────────────────────────────── */

const colorEnabled =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb";

const paint = (code, text) =>
  colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;

export const style = {
  bold: (text) => paint("1", text),
  dim: (text) => paint("2", text),
  red: (text) => paint("31", text),
  green: (text) => paint("32", text),
  yellow: (text) => paint("33", text),
  cyan: (text) => paint("36", text),
};

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** 东亚宽字符占两列：终端里中文标签才能对齐。 */
function isWideChar(char) {
  const code = char.codePointAt(0);
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  );
}

export function textWidth(text) {
  let width = 0;
  for (const char of text.replace(ANSI_PATTERN, "")) {
    width += isWideChar(char) ? 2 : 1;
  }
  return width;
}

/** 按终端列宽补空格（中文按两列算）。 */
export function padEndWidth(text, width) {
  return text + " ".repeat(Math.max(0, width - textWidth(text)));
}

/* ─────────────────────────────── 数值格式化 ─────────────────────────────── */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "未知";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function formatSeconds(seconds, digits = 3) {
  return Number.isFinite(seconds) ? `${seconds.toFixed(digits)}s` : "未知";
}

export function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "未知";
}

/** 帧率：`30000/1001` → `29.97 fps (30000/1001)`。 */
export function formatFps(rate) {
  if (typeof rate !== "string" || !rate.includes("/")) return String(rate ?? "未知");
  const [numerator, denominator] = rate.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return rate;
  }
  const fps = numerator / denominator;
  const shown = Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
  return `${shown} fps (${rate})`;
}

/** 把 ffprobe 的比特率（bit/s）换算成 kbps 展示。 */
export function formatBitRate(bitRate) {
  const value = Number(bitRate);
  return Number.isFinite(value) && value > 0 ? `${(value / 1000).toFixed(1)} kbps` : "未知";
}

/** 展示路径：相对当前工作目录（更短）优先，否则用绝对路径。 */
export function displayPath(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(process.cwd(), absolute);
  if (!relative) return ".";
  return relative.startsWith("..") || path.isAbsolute(relative) ? absolute : relative;
}

/* ─────────────────────────────── 参数解析 ─────────────────────────────── */

/**
 * 极简参数解析，够用且不用依赖：
 *   --flag             布尔开关
 *   --key value        取值（`-1` 这类负数也能正确消费）
 *   --key=value        紧凑写法
 *   -h / --help        打印自动生成的帮助
 *
 * spec 形如：
 *   { json: { type: "boolean", help: "输出完整 JSON" },
 *     "black-threshold": { type: "number", default: 20, valueHint: "0-255", help: "黑帧阈值" } }
 */
export function parseArgs(argv, spec, { tool, usage, description }) {
  const values = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.type === "boolean") values[name] = def.default ?? false;
    else if (def.default !== undefined) values[name] = def.default;
  }

  const positionals = [];
  const assign = (name, def, token, inline, next) => {
    if (def.type === "boolean") {
      if (inline !== undefined) throw new CliError(`${token} 是开关，不接受取值`);
      values[name] = true;
      return undefined;
    }
    let raw = inline;
    if (raw === undefined) {
      raw = next();
      if (raw === undefined) throw new CliError(`${token} 缺少取值（--help 查看用法）`);
    }
    if (def.type === "number") {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new CliError(`${token} 需要数值，收到 "${raw}"`);
      values[name] = number;
    } else if (def.type === "list") {
      values[name] = raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (def.item === "number" ? Number(part) : part));
      if (def.item === "number" && values[name].some((item) => !Number.isFinite(item))) {
        throw new CliError(`${token} 需要逗号分隔的数值列表，收到 "${raw}"`);
      }
    } else {
      values[name] = raw;
    }
    return undefined;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "-h" || token === "--help") {
      printHelp({ tool, usage, description }, spec);
      throw new HelpRequested();
    }
    const equals = token.indexOf("=");
    const name = (equals === -1 ? token : token.slice(0, equals)).replace(/^--?/, "");
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const def = spec[name];
    if (!def) throw new CliError(`未知参数 ${token}（--help 查看用法）`);
    assign(name, def, token, inline, () => argv[(index += 1)]);
  }

  return { values, positionals };
}

function printHelp({ tool, usage, description }, spec) {
  const labelWidth = Math.max(
    24,
    ...Object.entries(spec).map(([name, def]) => {
      const hint = def.type === "boolean" ? "" : ` <${def.valueHint ?? (def.type === "number" ? "数值" : "值")}>`;
      return textWidth(`  --${name}${hint}`) + 2;
    }),
  );
  const lines = [`${tool} —— ${description}`, "", `用法：${usage}`, "", "选项："];
  for (const [name, def] of Object.entries(spec)) {
    const hint = def.type === "boolean" ? "" : ` <${def.valueHint ?? (def.type === "number" ? "数值" : "值")}>`;
    const label = padEndWidth(`  --${name}${hint}`, labelWidth);
    const fallback =
      def.type !== "boolean" && def.default !== undefined ? `（默认 ${def.default}）` : "";
    lines.push(`${label}${def.help ?? ""}${fallback}`);
  }
  lines.push(padEndWidth("  -h, --help", labelWidth) + "显示本帮助");
  process.stdout.write(`${lines.join("\n")}\n`);
}

/* ─────────────────────────────── 子进程封装 ─────────────────────────────── */

/**
 * 运行一个命令并捕获输出。
 * 非零退出码不抛错——ffmpeg 的"失败"常常是有意义的信号，交给调用方判断；
 * 只有进程根本起不来（ENOENT 等）才 reject。
 */
export async function run(command, args, { cwd, env } = {}) {
  const startedAt = process.hrtime.bigint();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(new CliError(`无法启动 ${command}：${error.message}`));
    });
    child.on("close", (code, signal) => {
      resolve({
        command,
        args,
        code: code ?? (signal ? -1 : 0),
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      });
    });
  });
}

/** 探测用：起不来就算失败，不抛错。 */
async function tryRun(command, args) {
  try {
    return await run(command, args);
  } catch {
    return null;
  }
}

/** 取 stderr 的末尾若干行，用于错误提示（ffmpeg 的关键信息都在最后）。 */
export function tail(text, lines = 12) {
  const kept = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return kept.slice(-lines).join("\n");
}

export function assertSuccess(result, what) {
  if (result.code === 0) return result;
  throw new CliError(`${what} 失败（退出码 ${result.code}）\n${tail(result.stderr)}`);
}

/* ────────────────────────── ffmpeg / ffprobe 定位 ────────────────────────── */

/** `ffmpeg -version` 首行：`ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright …`。 */
async function probeVersion(binary) {
  const result = await tryRun(binary, ["-version"]);
  if (!result || result.code !== 0) return null;
  const match = /^\s*\S+ version (\S+)/m.exec(`${result.stdout}\n${result.stderr}`);
  if (!match) return null;
  return {
    raw: match[1],
    display: /^\d+(?:\.\d+)*/.exec(match[1])?.[0] ?? match[1],
  };
}

/** 按名字直接调用，让系统自行解析 PATH（覆盖 PATHEXT、转义写法等边界情况）。 */
async function probeByName(source, attempts) {
  const ffmpegVersion = await probeVersion("ffmpeg");
  if (!ffmpegVersion) return null;
  const ffprobeVersion = await probeVersion("ffprobe");
  if (!ffprobeVersion) {
    attempts.push(`${source}：ffmpeg 可用，但 ffprobe 不可用`);
    return null;
  }
  return { ffmpeg: "ffmpeg", ffprobe: "ffprobe", source, ffmpegVersion, ffprobeVersion };
}

let toolsPromise = null;

/** 定位 ffmpeg / ffprobe（结果在进程内缓存）。 */
export async function resolveTools() {
  if (!toolsPromise) toolsPromise = locateTools();
  return toolsPromise;
}

async function locateTools() {
  const attempts = [];
  const byName = await probeByName("PATH（按名字直接调用）", attempts);
  if (byName) return byName;

  throw new CliError(
    [
      "找不到可用的 ffmpeg / ffprobe（两者必须成对，且来自同一份完整版构建）。",
      ...attempts.map((line) => `  · ${line}`),
      "处理办法：",
      "  1) 安装完整版 ffmpeg 并确保 bin 目录在 PATH 中（注意：新开的终端才会生效；",
      "     质检依赖 signalstats / loudnorm / silencedetect / framemd5 缺一不可）；",
      "  2) 环境问题请在本机解决——工具不读取特定环境变量或注册表。",
    ].join("\n"),
  );
}

export async function runFfmpeg(args, options) {
  const tools = await resolveTools();
  return run(tools.ffmpeg, ["-hide_banner", "-nostdin", ...args], options);
}

export async function runFfprobe(args, options) {
  const tools = await resolveTools();
  return run(tools.ffprobe, ["-hide_banner", ...args], options);
}

/** 供报告展示：`ffmpeg 9.0.2 · PATH（按名字直接调用）`。 */
export function describeTools(tools) {
  return `ffmpeg ${tools.ffmpegVersion.display} · ${tools.source}`;
}

/** 文件存在性检查，返回绝对路径与大小。 */
export function assertFile(file, label = "输入文件") {
  const absolute = path.resolve(file);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new CliError(`${label}不存在：${displayPath(absolute)}`);
  }
  if (!stats.isFile()) throw new CliError(`${label}不是文件：${displayPath(absolute)}`);
  return { path: absolute, sizeBytes: stats.size };
}

export async function ffprobeJson(file, extraArgs = []) {
  const result = await runFfprobe([
    "-v",
    "error",
    ...extraArgs,
    "-of",
    "json",
    file,
  ]);
  assertSuccess(result, `ffprobe 读取 ${displayPath(file)}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new CliError(`ffprobe 输出不是合法 JSON：${error.message}\n${tail(result.stdout, 5)}`);
  }
}

/**
 * 采集容器与流信息。
 * countFrames=true 时额外逐帧解码计数（stream.nb_read_frames），耗时与片长成正比。
 */
export async function readMediaInfo(file, { countFrames = false } = {}) {
  const info = await ffprobeJson(file, [
    ...(countFrames ? ["-count_frames"] : []),
    "-show_streams",
    "-show_format",
  ]);
  return {
    streams: info.streams ?? [],
    format: info.format ?? {},
    video: (info.streams ?? []).find((stream) => stream.codec_type === "video") ?? null,
    audio: (info.streams ?? []).find((stream) => stream.codec_type === "audio") ?? null,
  };
}

/* ─────────────────────────────── 报告输出 ─────────────────────────────── */

/**
 * 统一的质检报告：
 *   终端模式 → 分组表格 + 备注 + 告警 + 结论；
 *   `--json` 模式 → 单份结构化 JSON（stdout 只有 JSON，别的输出都走 stderr）。
 */
export class Report {
  constructor(tool, { json = false, subjects = [] } = {}) {
    this.tool = tool;
    this.json = json;
    this.subjects = subjects;
    this.blocks = [];
    this.notes = [];
    this.issues = [];
    this.extra = {};
  }

  /** 一组 `[标签, 值, 状态?]` 行；状态取 "ok" | "warn" | "error"（只影响着色）。 */
  section(title, rows = []) {
    this.blocks.push({ title, rows });
    return this;
  }

  note(text) {
    this.notes.push(text);
    return this;
  }

  /** 记录一条告警：只要有一条，退出码就是 1。 */
  problem(code, message) {
    this.issues.push({ code, message });
    return this;
  }

  /** 结构化明细（进 JSON，也可以用来在终端上再渲染）。 */
  data(patch) {
    Object.assign(this.extra, patch);
    return this;
  }

  get passed() {
    return this.issues.length === 0;
  }

  result() {
    return {
      tool: this.tool,
      subjects: this.subjects,
      passed: this.passed,
      issues: this.issues,
      notes: this.notes,
      ...this.extra,
      sections: this.blocks.map((block) => ({
        title: block.title,
        rows: block.rows.map(([label, value, status]) => ({
          label,
          value,
          ...(status ? { status } : {}),
        })),
      })),
    };
  }

  emit() {
    if (this.json) {
      process.stdout.write(`${JSON.stringify(this.result(), null, 2)}\n`);
      return this.passed ? EXIT.PASS : EXIT.ISSUE;
    }
    this.print();
    return this.passed ? EXIT.PASS : EXIT.ISSUE;
  }

  print() {
    const out = process.stdout;
    out.write(
      `${style.bold(this.tool)}${this.subjects.length ? ` ${style.dim("·")} ${this.subjects.join(` ${style.dim("·")} `)}` : ""}\n`,
    );
    for (const block of this.blocks) {
      out.write(`\n${style.bold(block.title)}\n`);
      const width = Math.min(
        18,
        Math.max(...block.rows.map(([label]) => textWidth(label)), 0),
      );
      for (const [label, value, status] of block.rows) {
        const painted =
          status === "ok"
            ? style.green(value)
            : status === "warn"
              ? style.yellow(value)
              : status === "error"
                ? style.red(value)
                : value;
        out.write(`  ${padEndWidth(label, width)}  ${painted}\n`);
      }
    }
    if (this.notes.length) {
      out.write(`\n${style.bold("备注")}\n`);
      for (const note of this.notes) out.write(`  ${style.dim("·")} ${note}\n`);
    }
    if (this.issues.length) {
      out.write(`\n${style.bold("告警")}\n`);
      for (const issue of this.issues) {
        out.write(`  ${style.yellow("·")} ${style.dim(`[${issue.code}]`)} ${issue.message}\n`);
      }
    }
    const verdict = this.passed
      ? style.green("通过（0 项告警）")
      : style.yellow(`有告警（${this.issues.length} 项）`);
    out.write(`\n${style.bold("结论")} ${verdict}\n`);
  }
}

/* ─────────────────────────────── 入口包装 ─────────────────────────────── */

/** 统一入口：捕获 CliError / HelpRequested，设置退出码。 */
export function runMain(main) {
  main()
    .then((code = EXIT.PASS) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof HelpRequested) {
        process.exitCode = EXIT.PASS;
        return;
      }
      if (error instanceof CliError) {
        process.stderr.write(`\n${style.red("错误")} ${error.message}\n`);
        process.exitCode = EXIT.ERROR;
        return;
      }
      process.stderr.write(`\n${style.red("未预料的错误")}\n${error?.stack ?? error}\n`);
      process.exitCode = EXIT.ERROR;
    });
}
