/**
 * 用无头 Chrome（Remotion 自带的 Chrome Headless Shell）离线渲染 Tone.js 音效。
 *
 * 为什么走无头浏览器而不是 Node 垫片：
 * Tone.js 依赖 standardized-audio-context，在浏览器里得到的是**真 Web Audio**
 * （OfflineAudioContext + 原生节点图），行为与 Studio 预览、以及将来任何浏览器
 * 里的音频调试完全一致；Node + node-web-audio-api 只是垫片，容易出现 API 缺口。
 *
 * 流程：注入 bundle → Tone.Offline 渲染 → AudioBuffer → WAV（含峰值归一化）→ 写文件。
 */
import { openBrowser } from "@remotion/renderer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundlePath = path.join(projectRoot, "build/sfx-browser.js");
const outputDir = path.join(projectRoot, "public/audio/sfx");
const manifestPath = path.join(projectRoot, "build/sfx-manifest.json");

const bundleSource = await readFile(bundlePath, "utf8");
await mkdir(outputDir, { recursive: true });

const sourceMapGetter = { getSourceMap: async () => null };
const browser = await openBrowser("chrome", {
  chromeMode: "headless-shell",
  logLevel: "error",
});

const manifest = {
  generatedAt: new Date().toISOString(),
  runtime: "headless-chrome (Remotion Chrome Headless Shell)",
  toneVersion: null,
  userAgent: null,
  effects: [],
};

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
  console.log(
    `注入音效 bundle（${(bundleSource.length / 1024).toFixed(1)} KiB）……`,
  );
  await page.evaluate(bundleSource);

  const probe = await page.evaluate("window.AudioForge.probe()");
  manifest.toneVersion = probe.toneVersion;
  manifest.userAgent = probe.userAgent;
  console.log(
    `能力探测：Tone ${probe.toneVersion} · OfflineAudioContext=${probe.offlineSupported} · ${probe.offlineSampleRate}Hz`,
  );

  const list = await page.evaluate("window.AudioForge.list()");
  for (const item of list) {
    const startedAt = Date.now();
    const rendered = await page.evaluate(
      `window.AudioForge.render(${JSON.stringify(item.name)})`,
    );
    const target = path.join(outputDir, `${item.name}.wav`);
    await writeFile(target, Buffer.from(rendered.wavBase64, "base64"));

    manifest.effects.push({
      name: item.name,
      path: path.relative(projectRoot, target).replaceAll("\\", "/"),
      method: item.method,
      sampleRate: rendered.sampleRate,
      channels: rendered.channels,
      durationInSeconds: Number(rendered.durationInSeconds.toFixed(4)),
      bytes: rendered.bytes,
      peakDbBeforeNormalize: Number(rendered.peakDb.toFixed(2)),
    });

    console.log(
      `${item.name.padEnd(7)} → ${(rendered.bytes / 1024).toFixed(1)} KiB · ` +
        `${rendered.durationInSeconds.toFixed(3)}s · ${rendered.sampleRate}Hz · ` +
        `${rendered.channels}ch · 合成峰值 ${rendered.peakDb.toFixed(2)}dBFS · ` +
        `${Date.now() - startedAt}ms`,
    );
  }

  await page.close();
} finally {
  await browser.close({ silent: true });
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`manifest: ${path.relative(projectRoot, manifestPath)}`);
