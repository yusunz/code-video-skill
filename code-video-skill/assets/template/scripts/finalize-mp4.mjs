/**
 * 收尾封装：把 Remotion 的原始输出修成"容器时长 = 视频流时长"。
 *
 * 背景：Remotion 渲染出的视频流本来就是精确的 N 帧，但音频轨用 AAC 编码，
 * 而 48kHz 下整秒时长不一定是 1024 采样/帧的整数倍（10s：480000 / 1024 =
 * 468.75），编码器会把最后一帧补到完整帧，容器时长因此比视频流多出几毫秒。
 *
 * 这里不做任何重新编码：只丢掉最后一个 AAC 包（内容已经是收尾音的静音尾部），
 * 再把视频流和音频流原样 copy 进新容器。
 *
 * 用法：node scripts/finalize-mp4.mjs [原始输入] [最终输出]
 * 默认：out/full-remotion-raw.mp4 → out/full.mp4（与 npm run render:full 对齐）
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const rawPath = path.resolve(
  process.argv[2] ?? path.join(projectRoot, "out/full-remotion-raw.mp4"),
);
const finalPath = path.resolve(
  process.argv[3] ?? path.join(projectRoot, "out/full.mp4"),
);

/**
 * 音频截断点默认取"视频流时长 - 0.02s"：这一步正好落进 AAC 补出来的尾巴里，
 * 丢掉最后一个包后音频轨仍然覆盖到成片结束。视频时长变化时无需改这个脚本；
 * 遇到特殊素材可用环境变量 AUDIO_KEEP_UNTIL_SECONDS 手工指定截断秒数。
 */
const AUDIO_TAIL_MARGIN_SECONDS = 0.02;

const ffprobeJson = async (file) => {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-show_entries",
    "stream=index,codec_type,nb_frames,duration",
    "-of",
    "json",
    file,
  ]);
  return JSON.parse(stdout);
};

const workDir = await mkdtemp(path.join(tmpdir(), "autovideo-finalize-"));
const audioPath = path.join(workDir, "audio-trimmed.m4a");

try {
  console.log(`原始输出：${path.relative(projectRoot, rawPath)}`);
  const raw = await ffprobeJson(rawPath);
  console.log(
    "  ",
    raw.streams
      .map(
        (s) =>
          `${s.codec_type}=${s.duration}s${s.nb_frames ? ` (${s.nb_frames} frames)` : ""}`,
      )
      .join("  "),
  );

  const videoStream = raw.streams.find((s) => s.codec_type === "video");
  const videoDuration = Number(videoStream?.duration);
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
    throw new Error("无法从原始输出的视频流读出时长，无法确定音频截断点");
  }
  const keepUntil =
    process.env.AUDIO_KEEP_UNTIL_SECONDS ??
    (videoDuration - AUDIO_TAIL_MARGIN_SECONDS).toFixed(3);
  console.log(`  视频流时长 ${videoDuration}s → 音频保留到 ${keepUntil}s`);

  // 1) 只取音频，丢掉最后一个 AAC 包（纯流拷贝，不重新编码）
  await run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    rawPath,
    "-vn",
    "-c:a",
    "copy",
    "-t",
    keepUntil,
    audioPath,
  ]);

  // 2) 视频流 + 裁剪后的音频流 → 最终文件
  await run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    rawPath,
    "-i",
    audioPath,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    finalPath,
  ]);

  const final = await ffprobeJson(finalPath);
  console.log(`最终成片：${path.relative(projectRoot, finalPath)}`);
  console.log(`  容器时长 ${final.format.duration}s`);
  for (const stream of final.streams) {
    console.log(
      `  ${stream.codec_type.padEnd(5)} ${stream.duration}s` +
        (stream.nb_frames ? ` · ${stream.nb_frames} frames` : ""),
    );
  }
  console.log(
    `  文件大小 ${((await stat(finalPath)).size / 1024 / 1024).toFixed(2)} MiB`,
  );
} finally {
  await rm(workDir, { recursive: true, force: true });
}
