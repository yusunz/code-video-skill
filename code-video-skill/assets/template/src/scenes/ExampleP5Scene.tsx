import type p5 from "p5";
import { RANDOM_SEED } from "../config";
import { P5Canvas, type P5DrawContext } from "../components/P5Canvas";
import { getRoughCanvas } from "../components/rough";
import { COLORS, rgba } from "../theme";
import { createSeededRandom } from "../utils/seededRandom";

/** 手绘弧线条数：条数越多越"密"，这里取 6 条保持画面透气。 */
const ARC_COUNT = 6;
/** 外圈刻度数量。 */
const TICK_COUNT = 12;
/** 固定墨点数量。 */
const SPECK_COUNT = 60;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 纸面：底色 + 极淡的蓝图网格。 */
const drawPaper = (p: p5, width: number, height: number) => {
  p.background(COLORS.paper);
  p.strokeWeight(1);
  p.stroke(rgba(COLORS.grid, 0.42));

  const step = 96;
  for (let x = step; x < width; x += step) {
    p.line(x, 0, x, height);
  }
  for (let y = step; y < height; y += step) {
    p.line(0, y, width, y);
  }
};

/**
 * 示例主体：一叠同心手绘弧线 + 外圈刻度，弧线按段内进度依次展开。
 * 形状只由种子、序号与段内进度决定，与真实时间无关。
 */
const drawRings = (context: P5DrawContext) => {
  const { canvas, width, height, progress, frame } = context;
  const rough = getRoughCanvas(canvas);
  const centerX = width * 0.5;
  const centerY = height * 0.46;

  for (let index = 0; index < ARC_COUNT; index++) {
    // 每条弧线比上一条晚出发：整段动画在 progress ≈ 0.8 时全部画完。
    const reveal = clamp01((progress / 0.8) * ARC_COUNT - index);
    if (reveal <= 0) {
      continue;
    }

    const radius = 150 + index * 56;
    const start = Math.PI * (0.12 + index * 0.24) + frame * 0.0065;
    const stop = start + Math.PI * 1.62 * reveal;
    // 冷青 / 纸白交替：rough.js 的手绘线条是全片"手作感"的来源。
    const isAccent = index % 2 === 1;

    rough.arc(centerX, centerY, radius * 2, radius * 2, start, stop, false, {
      seed: 200 + index * 13,
      roughness: 1.5,
      bowing: 1.2,
      stroke: isAccent ? rgba(COLORS.cyan, 0.78) : COLORS.chalk,
      strokeWidth: isAccent ? 2 : 2.6,
    });
  }

  // 外圈刻度：长度带一点正弦脉冲，脉冲同样只来自帧号。
  const tickRadius = (150 + (ARC_COUNT - 1) * 56) * 1.2;
  for (let tick = 0; tick < TICK_COUNT; tick++) {
    const angle = frame * 0.0065 + (tick / TICK_COUNT) * Math.PI * 2;
    const inner = tickRadius;
    const outer = inner + 18 + 14 * Math.sin(frame * 0.09 + tick * 0.8);
    const isMajor = tick % 3 === 0;

    rough.line(
      centerX + Math.cos(angle) * inner,
      centerY + Math.sin(angle) * inner,
      centerX + Math.cos(angle) * outer,
      centerY + Math.sin(angle) * outer,
      {
        seed: 300 + tick,
        roughness: 1.1,
        stroke: isMajor ? COLORS.amber : rgba(COLORS.chalk, 0.7),
        strokeWidth: isMajor ? 4 : 2,
      },
    );
  }
};

/** 沿外圈巡航的高亮点：整段动画的"指针"，让静止的手绘画面有呼吸。 */
const drawScanner = (context: P5DrawContext) => {
  const { p, width, height, progress, frame } = context;
  const angle = frame * 0.012 + progress * Math.PI * 0.6;
  const radius = (150 + (ARC_COUNT - 1) * 56) * 1.06;
  const x = width * 0.5 + Math.cos(angle) * radius;
  const y = height * 0.46 + Math.sin(angle) * radius;

  p.noStroke();
  for (let halo = 3; halo >= 1; halo--) {
    p.fill(127, 212, 255, 16 * halo);
    p.ellipse(x, y, 20 * halo, 20 * halo);
  }
  p.fill(COLORS.amber);
  p.ellipse(x, y, 12, 12);
};

/** 固定的墨点：位置来自独立种子，与帧号无关，因此每帧完全一致。 */
const drawInkSpecks = (context: P5DrawContext) => {
  const { p, width, height, seed } = context;
  const random = createSeededRandom(seed + 7);

  p.noStroke();
  for (let index = 0; index < SPECK_COUNT; index++) {
    const x = random() * width;
    const y = random() * height;
    const size = 1 + random() * 2.4;
    p.fill(232, 227, 211, 26 + random() * 56);
    p.ellipse(x, y, size, size);
  }
};

const drawExampleFrame = (context: P5DrawContext) => {
  drawPaper(context.p, context.width, context.height);
  drawRings(context);
  drawScanner(context);
  drawInkSpecks(context);
};

/**
 * 段落 1：p5.js 手绘示例。
 *
 * 换成自己的画面时，只替换 `drawExampleFrame` 内部绘制的内容即可；
 * P5Canvas 适配层（instance mode / noLoop / 固定种子 / delayRender）不用动。
 */
export const ExampleP5Scene: React.FC = () => {
  return (
    <P5Canvas
      draw={drawExampleFrame}
      seed={RANDOM_SEED}
      style={{ backgroundColor: COLORS.paper }}
    />
  );
};
