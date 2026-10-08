/**
 * 把 src/audio 下的 Tone.js 音效源码打成一份浏览器 IIFE bundle。
 *
 * 生成 WAV 时需要"真 Web Audio"（OfflineAudioContext），
 * 所以音效源码要能在无头 Chrome 里直接跑，这一步负责产出那份可注入的脚本。
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const result = await build({
  entryPoints: [path.join(projectRoot, "src/audio/render-client.ts")],
  outfile: path.join(projectRoot, "build/sfx-browser.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs);
for (const [file, info] of outputs) {
  console.log(
    `bundle: ${path.relative(projectRoot, file)} (${(info.bytes / 1024).toFixed(1)} KiB)`,
  );
}
