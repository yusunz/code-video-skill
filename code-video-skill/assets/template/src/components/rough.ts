import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";

/**
 * rough.js 直接往 canvas 的 2D context 上画，因此一个 canvas 只需要（也只能）建一次。
 * 用 WeakMap 缓存，p5 实例被 remove() 之后对应的缓存也会随之被回收。
 */
const roughCanvasCache = new WeakMap<HTMLCanvasElement, RoughCanvas>();

export const getRoughCanvas = (canvas: HTMLCanvasElement): RoughCanvas => {
  const cached = roughCanvasCache.get(canvas);
  if (cached) {
    return cached;
  }

  const created = rough.canvas(canvas);
  roughCanvasCache.set(canvas, created);
  return created;
};
