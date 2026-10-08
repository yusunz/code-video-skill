/**
 * mulberry32：32 位种子伪随机数。
 *
 * 3D 场景里的粒子位置需要在 React 多次渲染之间保持完全一致，
 * 又不能依赖 `Math.random()`（会破坏逐帧确定性），因此统一走这里。
 */
export const createSeededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
