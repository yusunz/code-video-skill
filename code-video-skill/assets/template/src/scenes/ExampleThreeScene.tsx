import { useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { SEGMENT_THREE_DURATION_IN_FRAMES } from "../config";
import { COLORS } from "../theme";

/**
 * 相机环绕：位置与朝向全部由段内进度推导。
 *
 * 关键顺序：three 的 `lookAt()` 以 `matrixWorld` 里的位置为基准计算朝向，而
 * `matrixWorld` 只在渲染时才刷新 —— 先 `updateMatrixWorld()` 才能让"本帧的
 * 位置"与"本帧的朝向"对齐；否则相机会一直用上一帧的位置瞄准，轨道运动时
 * 主体会被挤出画面中心。
 */
const CameraRig: React.FC<{ progress: number }> = ({ progress }) => {
  const camera = useThree((state) => state.camera);

  const orbit = -0.5 + progress * 1;
  const distance = 9.6 - 1.5 * Math.sin(Math.PI * progress);

  camera.position.set(
    Math.sin(orbit) * distance,
    1.35 + 1.15 * progress,
    Math.cos(orbit) * distance,
  );
  camera.updateMatrixWorld();
  camera.lookAt(0, 0.2, 0);

  return null;
};

/** 示例主体：金属多面体 + 反向自转的线框外壳，整体由帧号驱动缓慢自转。 */
const Subject: React.FC<{ frame: number }> = ({ frame }) => {
  return (
    <group rotation={[0.3 + frame * 0.008, frame * 0.013, frame * 0.004]}>
      <mesh>
        <icosahedronGeometry args={[1.5, 1]} />
        <meshStandardMaterial
          color="#8fb6ff"
          emissive="#101f38"
          emissiveIntensity={0.9}
          metalness={0.72}
          roughness={0.24}
          flatShading={true}
        />
      </mesh>
      <mesh rotation={[0.2, -frame * 0.006, 0.1]}>
        <dodecahedronGeometry args={[2.4, 0]} />
        <meshBasicMaterial
          color={COLORS.cyan}
          wireframe={true}
          transparent={true}
          opacity={0.14}
        />
      </mesh>
    </group>
  );
};

const ExampleSceneContents: React.FC = () => {
  const frame = useCurrentFrame();
  const progress = frame / (SEGMENT_THREE_DURATION_IN_FRAMES - 1);

  return (
    <>
      <CameraRig progress={progress} />
      <ambientLight intensity={0.5} color="#c7d7ff" />
      <directionalLight position={[4, 6, 3]} intensity={2.4} color="#dbeafe" />
      <pointLight
        position={[-6, -2, -4]}
        intensity={80}
        color="#7c5cff"
        distance={40}
      />
      <pointLight
        position={[6, 3, -5]}
        intensity={60}
        color={COLORS.cyan}
        distance={40}
      />
      <gridHelper
        args={[40, 40, COLORS.grid, "#101a2c"]}
        position={[0, -2.6, 0]}
      />
      <Subject frame={frame} />
    </>
  );
};

/**
 * 段落 2：three.js 3D 示例。
 *
 * 一律用 `@remotion/three` 的 `<ThreeCanvas>`：它把 R3F 的 frameloop 设为 never，
 * 由 Remotion 每帧 advance 一次，因此**禁用 `useFrame()`**，所有位移与旋转都必须
 * 由 `useCurrentFrame()` 推导；换成自己的画面时替换 `ExampleSceneContents` 即可。
 */
export const ExampleThreeScene: React.FC = () => {
  const { width, height } = useVideoConfig();

  return (
    <ThreeCanvas
      width={width}
      height={height}
      camera={{ fov: 32, near: 0.1, far: 120, position: [0, 1.6, 9.6] }}
      style={{ position: "absolute", top: 0, left: 0 }}
    >
      <color attach="background" args={["#050810"]} />
      <ExampleSceneContents />
    </ThreeCanvas>
  );
};
