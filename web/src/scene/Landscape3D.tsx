// 三维山水长卷（PRD 11.5、13.2）。这个文件单独分包，首页先用平面山水，3D 准备好后淡入。
// 约束：单个 Canvas；桌面 DPR ≤1.5、移动 ≤1；可见三角形 ≤80k、draw calls ≤60；无实时阴影；
// 文字、按钮全部在 DOM 里，Canvas 只画山体、雾层、路径与站点标记，不拦截 DOM 操作。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { reportFailure } from './immersion';

export interface SceneStation { station: number; status: 'done' | 'in_progress' | 'not_started' }

const COLORS = {
  sky: '#f5f6f3',
  ridges: ['#c9dbd1', '#a8c7b7', '#7fa595', '#4f7d6e'], // 远 → 近，冷调青绿，越近越深
  path: '#9a8054',
  done: '#2f6f62',
  todo: '#c9d3cd',
  current: '#255a4f',
  mist: '#f5f6f3',
};

/** 确定性的平滑噪声（不依赖随机数，每次进入山形一致） */
function ridgeHeight(x: number, layer: number) {
  const s = layer * 17.3;
  return (
    Math.sin(x * 0.18 + s) * 1.1 +
    Math.sin(x * 0.41 + s * 1.7) * 0.55 +
    Math.sin(x * 0.93 + s * 0.3) * 0.22 +
    Math.sin(x * 2.1 + s * 2.3) * 0.08
  );
}

const X_MIN = -26;
const X_MAX = 26;

/** 山体一层：上沿按噪声起伏、下沿平直的“剪影带”，顶点数很少（每层约 2×SEG 个三角形） */
function Ridge({ layer }: { layer: number }) {
  const ref = useRef<THREE.BufferGeometry>(null);
  const SEG = 240;
  const z = -14 + layer * 4.2;
  const base = -3.2 - layer * 0.35;
  const amp = 1.6 - layer * 0.22;
  const lift = 2.2 - layer * 0.75;
  useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return;
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i <= SEG; i += 1) {
      const x = X_MIN + ((X_MAX - X_MIN) * i) / SEG;
      const top = lift + ridgeHeight(x, layer) * amp;
      pos.set([x, top, 0], i * 6);
      pos.set([x, base - 4, 0], i * 6 + 3);
      if (i < SEG) {
        const a = i * 2; const b = a + 1; const c = a + 2; const d = a + 3;
        idx.push(a, b, c, b, d, c);
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
  }, [layer, amp, base, lift]);
  return (
    <mesh position={[0, 0, z]}>
      <bufferGeometry ref={ref} />
      <meshBasicMaterial color={COLORS.ridges[layer]} />
    </mesh>
  );
}

/** 雾层：横向渐变的半透明带，缓慢平移（减少动画时静止） */
function Mist({ y, z, speed, reduced, opacity }: { y: number; z: number; speed: number; reduced: boolean; opacity: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 32;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, 'rgba(245,246,243,0)');
    g.addColorStop(0.5, 'rgba(245,246,243,1)');
    g.addColorStop(1, 'rgba(245,246,243,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 32);
    const t = new THREE.CanvasTexture(c);
    return t;
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  useFrame(({ clock }) => {
    if (reduced || !ref.current) return;
    ref.current.position.x = Math.sin(clock.elapsedTime * speed) * 1.2;
  });
  return (
    <mesh ref={ref} position={[0, y, z]}>
      <planeGeometry args={[70, 2.4]} />
      <meshBasicMaterial map={tex} transparent opacity={opacity} depthWrite={false} />
    </mesh>
  );
}

/** 11站的位置：沿一条从左下到右上的路径 */
export function stationPositions(n: number) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const x = -15 + t * 30;
    pts.push(new THREE.Vector3(x, -1.9 + t * 1.6 + Math.sin(t * Math.PI * 2) * 0.35, -1.2 - Math.sin(t * Math.PI) * 1.6));
  }
  return pts;
}

function Path({ points, stations, current, reduced }: { points: THREE.Vector3[]; stations: SceneStation[]; current: number; reduced: boolean }) {
  const curve = useMemo(() => new THREE.CatmullRomCurve3(points), [points]);
  const doneRef = useRef<THREE.InstancedMesh>(null);
  const todoRef = useRef<THREE.InstancedMesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const done = stations.filter((s) => s.status === 'done');
  const todo = stations.filter((s) => s.status !== 'done');
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    done.forEach((s, i) => { m.makeTranslation(points[s.station - 1]); doneRef.current?.setMatrixAt(i, m); });
    todo.forEach((s, i) => { m.makeTranslation(points[s.station - 1]); todoRef.current?.setMatrixAt(i, m); });
    if (doneRef.current) doneRef.current.instanceMatrix.needsUpdate = true;
    if (todoRef.current) todoRef.current.instanceMatrix.needsUpdate = true;
  }, [done, todo, points]);
  useFrame(({ clock }) => {
    if (!ringRef.current) return;
    const s = reduced ? 1 : 1 + Math.sin(clock.elapsedTime * 2) * 0.08;
    ringRef.current.scale.setScalar(s);
  });
  const cur = points[current - 1];
  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 160, 0.045, 6, false]} />
        <meshBasicMaterial color={COLORS.path} />
      </mesh>
      {!!done.length && (
        <instancedMesh ref={doneRef} args={[undefined, undefined, done.length]}>
          <sphereGeometry args={[0.2, 16, 12]} />
          <meshBasicMaterial color={COLORS.done} />
        </instancedMesh>
      )}
      {!!todo.length && (
        <instancedMesh ref={todoRef} args={[undefined, undefined, todo.length]}>
          <sphereGeometry args={[0.16, 16, 12]} />
          <meshBasicMaterial color={COLORS.todo} />
        </instancedMesh>
      )}
      {cur && (
        <mesh ref={ringRef} position={cur}>
          <torusGeometry args={[0.36, 0.05, 8, 40]} />
          <meshBasicMaterial color={COLORS.current} />
        </mesh>
      )}
    </group>
  );
}

const HOME = new THREE.Vector3(0, 0.6, 9);

/**
 * 镜头：常态只有 ≤2° 的鼠标视差；focus 变化时轻推近当前站（约 550ms，随时可中断）。
 * 同时负责：帧率监测（持续 5 秒低于 24fps 先降 DPR，仍不行就转 2D）、统计三角形与 draw calls。
 */
function Rig({ focus, points, reduced, onStats }: { focus: number | null; points: THREE.Vector3[]; reduced: boolean; onStats: (s: SceneStats) => void }) {
  const { camera, gl, setDpr, size } = useThree();
  const pointer = useRef({ x: 0, y: 0 });
  const anim = useRef<{ from: THREE.Vector3; to: THREE.Vector3; lookFrom: THREE.Vector3; lookTo: THREE.Vector3; t0: number; dur: number } | null>(null);
  const look = useRef(new THREE.Vector3(0, -0.6, 0));
  const fps = useRef({ frames: 0, since: performance.now(), lowFor: 0, stage: 0 });

  useEffect(() => {
    const onMove = (e: PointerEvent) => { pointer.current = { x: (e.clientX / window.innerWidth) * 2 - 1, y: (e.clientY / window.innerHeight) * 2 - 1 }; };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useEffect(() => {
    const target = focus ? points[focus - 1] : null;
    const to = target ? new THREE.Vector3(target.x * 0.85, target.y + 1.2, target.z + 5.2) : HOME.clone();
    const lookTo = target ? target.clone() : new THREE.Vector3(0, -0.6, 0);
    if (reduced) { camera.position.copy(to); look.current.copy(lookTo); camera.lookAt(lookTo); return; }
    anim.current = { from: camera.position.clone(), to, lookFrom: look.current.clone(), lookTo, t0: performance.now(), dur: 550 };
  }, [focus, points, reduced, camera]);

  useFrame(() => {
    const now = performance.now();
    const a = anim.current;
    if (a) {
      const k = Math.min(1, (now - a.t0) / a.dur);
      const e = 1 - (1 - k) ** 3;
      camera.position.lerpVectors(a.from, a.to, e);
      look.current.lerpVectors(a.lookFrom, a.lookTo, e);
      if (k >= 1) anim.current = null;
    }
    camera.lookAt(look.current);
    if (!reduced) {
      // 视差上限约 2°
      const maxRad = (2 * Math.PI) / 180;
      camera.rotation.y += -pointer.current.x * maxRad * 0.5;
      camera.rotation.x += -pointer.current.y * maxRad * 0.3;
    }

    // 帧率监测
    const f = fps.current;
    f.frames += 1;
    const dt = now - f.since;
    if (dt >= 1000) {
      const rate = (f.frames * 1000) / dt;
      f.frames = 0; f.since = now;
      if (document.visibilityState === 'visible') f.lowFor = rate < 24 ? f.lowFor + dt : 0;
      if (f.lowFor >= 5000) {
        f.lowFor = 0;
        f.stage += 1;
        if (f.stage === 1) setDpr(1);
        else if (f.stage === 2) setDpr(0.75);
        else reportFailure('lowfps');
      }
      onStats({ fps: Math.round(rate), triangles: gl.info.render.triangles, calls: gl.info.render.calls, dpr: gl.getPixelRatio(), width: size.width });
    }
  });
  return null;
}

export interface SceneStats { fps: number; triangles: number; calls: number; dpr: number; width: number }

export default function Landscape3D({ stations, current, focus, reduced, onReady }: {
  stations: SceneStation[]; current: number; focus: number | null; reduced: boolean; onReady: () => void;
}) {
  const points = useMemo(() => stationPositions(11), []);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;

  useEffect(() => {
    const h = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, []);

  const onStats = (s: SceneStats) => { (window as unknown as { __swzScene?: SceneStats }).__swzScene = s; };

  return (
    <Canvas
      className="scene-canvas"
      dpr={[1, mobile ? 1 : 1.5]}
      frameloop={visible ? 'always' : 'never'}
      gl={{ antialias: !mobile, alpha: true, powerPreference: 'low-power' }}
      camera={{ position: HOME.toArray() as [number, number, number], fov: 42, near: 0.1, far: 80 }}
      onCreated={({ gl }) => {
        gl.setClearColor(COLORS.sky, 0);
        const el = gl.domElement;
        el.addEventListener('webglcontextlost', (e) => { e.preventDefault(); reportFailure('contextlost'); }, { once: true });
        requestAnimationFrame(() => onReady());
      }}
      style={{ pointerEvents: 'none' }}
      aria-hidden="true"
    >
      <fog attach="fog" args={[COLORS.sky, 10, 30]} />
      {[0, 1, 2, 3].map((l) => <Ridge key={l} layer={l} />)}
      <Mist y={-0.4} z={-8} speed={0.05} reduced={reduced} opacity={0.55} />
      <Mist y={-2.2} z={-3} speed={0.07} reduced={reduced} opacity={0.45} />
      <Path points={points} stations={stations} current={current} reduced={reduced} />
      <Rig focus={focus} points={points} reduced={reduced} onStats={onStats} />
    </Canvas>
  );
}
