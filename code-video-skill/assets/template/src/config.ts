/**
 * 全片规格与时间轴 —— 模板里唯一的"事实来源"。
 *
 * 起一条新片子时先改这里：标题、段落秒数、音效落点、随机种子。
 * 段落长度先写成"秒"，再统一换算成帧，并在模块加载时校验总和恰好等于
 * 总帧数，这样"成片 10.0 秒"只有一个出处，不会在多处硬编码后悄悄漂移。
 */

/** 成片标题：显示在 HUD 顶栏，也是改片时第一处要改的东西。 */
export const VIDEO_TITLE = "模板示例 · p5 手绘 + three 3D · 10 秒";

/**
 * HUD 调试层开关（默认关闭）。
 *
 * 打开后显示右上角帧号与左下分镜卡（场景序号 / 名称 / 技术）——仅用于抽帧自检时定位；
 * 交付成片必须保持关闭：帧号、秒数、分镜编号与名称等制作信息不进入成品。
 */
export const SHOW_DEBUG_HUD = false;

export const VIDEO_FPS = 30;
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const VIDEO_DURATION_IN_SECONDS = 10;

/** 段落长度：段落 1 走 p5.js，段落 2 走 three.js。 */
export const SEGMENT_DURATION_IN_SECONDS = {
  p5: 5,
  three: 5,
} as const;

const secondsToFrames = (seconds: number) => Math.round(seconds * VIDEO_FPS);

export const SEGMENT_P5_DURATION_IN_FRAMES = secondsToFrames(
  SEGMENT_DURATION_IN_SECONDS.p5,
);
export const SEGMENT_THREE_DURATION_IN_FRAMES = secondsToFrames(
  SEGMENT_DURATION_IN_SECONDS.three,
);

export const SEGMENT_P5_START_FRAME = 0;
export const SEGMENT_THREE_START_FRAME =
  SEGMENT_P5_START_FRAME + SEGMENT_P5_DURATION_IN_FRAMES;

export const TOTAL_DURATION_IN_FRAMES = VIDEO_DURATION_IN_SECONDS * VIDEO_FPS;

const summedFrames =
  SEGMENT_P5_DURATION_IN_FRAMES + SEGMENT_THREE_DURATION_IN_FRAMES;

if (summedFrames !== TOTAL_DURATION_IN_FRAMES) {
  throw new Error(
    `段落帧数之和必须恰好等于成片总帧数：当前 ${summedFrames} ≠ ${TOTAL_DURATION_IN_FRAMES}`,
  );
}

/** whoosh 的包络峰值在自身 0.45s 处：提前 0.45s 出发，峰值正好压在段落切换帧上。 */
export const WHOOSH_LEAD_IN_SECONDS = 0.45;

/** outro.wav 的时长：从"成片末尾 - 该时长"处开始挂载，正好铺满收尾。 */
export const OUTRO_DURATION_IN_SECONDS = 1.6;

/**
 * 音效总线增益。
 *
 * 段落切换点上 whoosh 与 impact 会叠加，三个音效又各自做过 -1.5dBFS 峰值归一化，
 * 直接叠加会让解码后的真峰顶到 0dBTP（实测 +0.1dBTP）。这里统一留约 3dB 余量，
 * 既保住响度，又保证真峰落在 -1dBTP 以内。整片更响/更静时只调这一个数。
 */
export const SFX_MASTER_VOLUME = 0.7;

/** 音效落点（帧号）。改片子时按需增删，音效本体在 `src/audio/sfx-definitions.ts`。 */
export const SFX_TIMELINE = {
  whooshToThree: {
    from: secondsToFrames(
      SEGMENT_DURATION_IN_SECONDS.p5 - WHOOSH_LEAD_IN_SECONDS,
    ),
    volume: 0.85,
  },
  impactAtThree: { from: SEGMENT_THREE_START_FRAME, volume: 0.95 },
  outro: {
    from: secondsToFrames(
      VIDEO_DURATION_IN_SECONDS - OUTRO_DURATION_IN_SECONDS,
    ),
    volume: 0.85,
  },
} as const;

/** p5 与 three 共用的随机种子：保证任意一帧都能被完全复现。 */
export const RANDOM_SEED = 20261006;
