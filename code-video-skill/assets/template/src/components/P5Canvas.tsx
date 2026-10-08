import p5 from "p5";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  continueRender,
  delayRender,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { RANDOM_SEED } from "../config";

/** 交给绘制函数的一切上下文：都是"这一帧"的纯数据，不含任何真实时间。 */
export type P5DrawContext = {
  readonly p: p5;
  /** p5 自己创建的 canvas 元素，供 rough.js 这类直接操作 canvas 的库使用 */
  readonly canvas: HTMLCanvasElement;
  /** 场景内的帧号（在 <Sequence> 中即相对帧号） */
  readonly frame: number;
  readonly durationInFrames: number;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  /**
   * frame / (durationInFrames - 1)，取值 0..1。
   * 注意：分母取自 useVideoConfig()——冷启动实测在段落 Sequence 内它可能仍是全片时长
   * （60 帧段落的 progress 峰值只到 59/299）。依赖它做段落动画会静默走不完，
   * 段落内请按段落帧数自行归一化。
   */
  readonly progress: number;
};

export type P5DrawFunction = (context: P5DrawContext) => void;

type P5CanvasProps = {
  readonly draw: P5DrawFunction;
  /** 透明画布：用于叠在 three.js 之上的前景层 */
  readonly transparent?: boolean;
  readonly seed?: number;
  readonly style?: React.CSSProperties;
};

/**
 * 在 Remotion 里使用 p5.js（instance mode）的适配层。
 *
 * 约定（也是本项目的硬性约束）：
 * - 只走 `new p5(sketch, container)` 的 instance mode，不用全局模式；
 * - `setup()` 里立即 `noLoop()`，p5 自己不再按真实时间循环，改由帧号驱动 `redraw()`；
 * - 每帧重绘前重置随机种子，`random()` / `noise()` 的结果只由种子和帧号决定；
 * - 画布尺寸固定为合成尺寸，`pixelDensity(1)`，避免设备像素比影响输出。
 */
export const P5Canvas: React.FC<P5CanvasProps> = ({
  draw,
  transparent = false,
  seed = RANDOM_SEED,
  style,
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<p5 | null>(null);
  const readyRef = useRef(false);
  const drawRef = useRef<P5DrawFunction>(draw);
  const frameRef = useRef(frame);

  // delayRender 必须在渲染阶段就登记，才能保证渲染器会等 p5 的 setup() 跑完再截图。
  const [setupHandle] = useState(() => delayRender("p5.js sketch 初始化"));

  drawRef.current = draw;
  frameRef.current = frame;

  useEffect(() => {
    const container = containerRef.current;
    let released = false;
    const releaseSetupHandle = () => {
      if (!released) {
        released = true;
        continueRender(setupHandle);
      }
    };

    if (!container) {
      releaseSetupHandle();
      throw new Error("P5Canvas 需要一个真实的容器节点");
    }

    const redrawCurrentFrame = () => {
      const sketch = instanceRef.current;
      if (!sketch || !readyRef.current || !containerCanvas) {
        return;
      }

      // 每次重绘都重置种子：随机性只来自种子与帧号，不来自调用时序。
      sketch.randomSeed(seed);
      sketch.noiseSeed(seed);

      const currentFrame = frameRef.current;
      drawRef.current({
        p: sketch,
        canvas: containerCanvas,
        frame: currentFrame,
        durationInFrames,
        width,
        height,
        seed,
        progress:
          durationInFrames > 1 ? currentFrame / (durationInFrames - 1) : 0,
      });
    };

    let containerCanvas: HTMLCanvasElement | null = null;

    const instance = new p5((sketch: p5) => {
      sketch.setup = () => {
        sketch.pixelDensity(1);
        const created = sketch.createCanvas(width, height);
        containerCanvas = created.elt as HTMLCanvasElement;
        sketch.noLoop();
        sketch.randomSeed(seed);
        sketch.noiseSeed(seed);
        if (transparent) {
          // 叠加层：把画布清成全透明，让下面的 three.js 画面透出来。
          // 之后的每一帧由 draw 自行决定清屏方式（背景色或 clear()）。
          sketch.clear();
        }
        readyRef.current = true;
        redrawCurrentFrame();
        releaseSetupHandle();
      };

      sketch.draw = () => {
        redrawCurrentFrame();
      };
    }, container);

    instanceRef.current = instance;

    return () => {
      readyRef.current = false;
      containerCanvas = null;
      instance.remove();
      instanceRef.current = null;
      // 组件在 setup() 之前就被卸载时，必须释放句柄，否则整次渲染会一直等下去。
      releaseSetupHandle();
    };
  }, [durationInFrames, height, seed, setupHandle, transparent, width]);

  // 帧号变化 → 重绘。用 useLayoutEffect 让绘制发生在浏览器合成这一帧之前。
  useLayoutEffect(() => {
    frameRef.current = frame;
    const sketch = instanceRef.current;
    if (sketch && readyRef.current) {
      void sketch.redraw();
    }
  }, [frame]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width,
        height,
        ...style,
      }}
    />
  );
};
