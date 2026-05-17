import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { useAnimations, useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { getToonGradient } from "./toonGradient";

// GLTF-backed Gooni character. Quaternius humanoid w/ 18 baked anims.
// Materials remapped to Gooni palette (white head, green body). Ears
// hidden — closest equivalent to spec's "remove hat".
//
// Exposes a ref handle so the parent (DanielAvatar) can drive clip
// crossfades imperatively (no React re-renders per hop).

const ASSET = "/models/character/Character.gltf";

// Material name → Gooni-spec color.
const MATERIAL_COLORS: Record<string, string> = {
  Main: "#4ade80",         // body → Gooni green
  Main_Light: "#ffffff",   // head → WHITE (spec)
  Main2: "#3aad6e",        // accents → darker green
  Black: "#1a1a1a",        // boots
  White: "#e6dec8",        // trim — warm offwhite
  EyeColor: "#0e1218",     // eyes — near-black
};

export type GooniHandle = {
  setClip: (name: ClipName, opts?: { loop?: boolean; timeScale?: number; fadeMs?: number }) => void;
  stopAll: () => void;
  headBone: () => THREE.Object3D | null;
  // Shift the eye highlights toward (dx, dy) in head-local coords.
  // Both axes are roughly [-1, +1] — applied as a tiny translation.
  setEyeLook: (dx: number, dy: number) => void;
};

export type ClipName =
  | "Idle" | "Walk" | "Run" | "Jump" | "Jump_Idle" | "Jump_Land"
  | "HitReact" | "Wave" | "Yes" | "No" | "Death" | "Duck" | "Punch";

type Props = {
  // Override the body (Main) + accent (Main_Light, Main2) colors so we
  // can spawn NPCs with different palettes from the same GLTF.
  bodyColor?: string;
  headColor?: string;
  accentColor?: string;
};

export const GLTFGooni = forwardRef<GooniHandle, Props>(function GLTFGooni(props, ref) {
  const gltf = useGLTF(ASSET);

  // Clone via SkeletonUtils — preserves skinned-mesh bone bindings
  // (plain .clone() reuses the original skeleton and breaks anims).
  const cloned = useMemo(() => cloneSkeleton(gltf.scene) as THREE.Group, [gltf.scene]);

  const groupRef = useRef<THREE.Group>(null);
  const { actions, mixer } = useAnimations(gltf.animations, groupRef);
  const currentRef = useRef<THREE.AnimationAction | null>(null);
  // Eye overlay state — set during model post-load below.
  const eyeGroupLRef = useRef<THREE.Group | null>(null);
  const eyeGroupRRef = useRef<THREE.Group | null>(null);
  const eyeLookRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const blinkRef = useRef<{ t: number; nextAt: number; closing: number }>({ t: 0, nextAt: 3, closing: 0 });

  useLayoutEffect(() => {
    const grad = getToonGradient();
    // Build a per-instance color map; props override the defaults.
    const colorMap: Record<string, string> = {
      ...MATERIAL_COLORS,
      ...(props.bodyColor ? { Main: props.bodyColor } : {}),
      ...(props.headColor ? { Main_Light: props.headColor } : {}),
      ...(props.accentColor ? { Main2: props.accentColor } : {}),
    };
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const origMat = mesh.material as THREE.Material | THREE.Material[];
      function convert(m: THREE.Material): THREE.Material {
        const matName = m.name;
        const color = colorMap[matName] ?? "#888888";
        return new THREE.MeshToonMaterial({
          color,
          gradientMap: grad,
        });
      }
      mesh.material = Array.isArray(origMat) ? origMat.map(convert) : convert(origMat);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
    });
    // Hide ears — Quaternius rabbit-elf appendages; closest equiv to
    // spec's "remove hat".
    cloned.traverse((n) => {
      if (n.name.startsWith("Ear")) n.visible = false;
    });

    // Attach eye-highlight overlays to the Head bone. Two small groups,
    // one per eye, each containing a flat black "iris" disc + a tiny
    // white "highlight" sphere offset upper-left. Positions are tuned
    // for the Quaternius humanoid head — eyes sit slightly forward
    // (+Z in head-local frame) and just above the bone origin.
    const head = cloned.getObjectByName("Head");
    if (head) {
      const EYE_FORWARD = 0.20;
      const EYE_UP = 0.06;
      const EYE_SPLAY = 0.08;
      const IRIS_R = 0.045;
      const HI_R = 0.018;

      function makeEye(side: 1 | -1): THREE.Group {
        const g = new THREE.Group();
        g.position.set(EYE_SPLAY * side, EYE_UP, EYE_FORWARD);
        const iris = new THREE.Mesh(
          new THREE.SphereGeometry(IRIS_R, 12, 10),
          new THREE.MeshBasicMaterial({ color: "#0e1218" }),
        );
        iris.renderOrder = 2;
        const hi = new THREE.Mesh(
          new THREE.SphereGeometry(HI_R, 8, 6),
          new THREE.MeshBasicMaterial({ color: "#ffffff" }),
        );
        // Upper-left highlight in head-local frame.
        hi.position.set(-0.012 * side, 0.012, IRIS_R * 0.7);
        hi.renderOrder = 3;
        g.add(iris);
        g.add(hi);
        return g;
      }

      const left = makeEye(-1);
      const right = makeEye(1);
      head.add(left);
      head.add(right);
      eyeGroupLRef.current = left;
      eyeGroupRRef.current = right;
    }
  }, [cloned, props.bodyColor, props.headColor, props.accentColor]);

  // Eye tick — drives blink timer + look-offset.
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const b = blinkRef.current;
    b.t += dt;
    if (b.closing > 0) {
      // Blink phase — quick 0.1s squash on Y axis.
      b.closing -= dt;
      const k = Math.max(0, b.closing / 0.1);
      const sy = 0.1 + 0.9 * (1 - k);
      if (eyeGroupLRef.current) eyeGroupLRef.current.scale.y = sy;
      if (eyeGroupRRef.current) eyeGroupRRef.current.scale.y = sy;
      if (b.closing <= 0) {
        if (eyeGroupLRef.current) eyeGroupLRef.current.scale.y = 1;
        if (eyeGroupRRef.current) eyeGroupRRef.current.scale.y = 1;
      }
    } else if (b.t >= b.nextAt) {
      b.closing = 0.1;
      b.t = 0;
      // Spec: 3-5s random.
      b.nextAt = 3 + Math.random() * 2;
    }
    // Look-shift — tiny translation along head-local X/Y per spec
    // (0.01-0.02 units).
    const look = eyeLookRef.current;
    const baseFwdL = 0.20;
    const baseUpL = 0.06;
    const baseSplayL = 0.08;
    if (eyeGroupLRef.current) {
      eyeGroupLRef.current.position.set(
        -baseSplayL + look.dx * 0.018,
        baseUpL + look.dy * 0.014,
        baseFwdL,
      );
    }
    if (eyeGroupRRef.current) {
      eyeGroupRRef.current.position.set(
        baseSplayL + look.dx * 0.018,
        baseUpL + look.dy * 0.014,
        baseFwdL,
      );
    }
  });

  useImperativeHandle(ref, () => ({
    setClip: (name, opts) => {
      const next = (actions as Record<string, THREE.AnimationAction | null>)[name];
      if (!next) return;
      const prev = currentRef.current;
      if (prev === next && next.isRunning()) return;
      const fadeS = (opts?.fadeMs ?? 150) / 1000;
      next.reset();
      next.setLoop(opts?.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = opts?.loop === false;
      next.timeScale = opts?.timeScale ?? 1;
      next.fadeIn(fadeS).play();
      if (prev && prev !== next) prev.fadeOut(fadeS);
      currentRef.current = next;
    },
    stopAll: () => {
      Object.values(actions).forEach((a) => a?.stop());
      currentRef.current = null;
    },
    headBone: () => cloned.getObjectByName("Head") ?? null,
    setEyeLook: (dx, dy) => {
      eyeLookRef.current.dx = Math.max(-1, Math.min(1, dx));
      eyeLookRef.current.dy = Math.max(-1, Math.min(1, dy));
    },
  }), [actions, cloned]);

  // Always tick mixer at frame rate. Parent gates motion via stopAll()
  // during lying/get-up phases (no React-driven prop needed).
  useFrame((_, dt) => {
    mixer.update(Math.min(dt, 0.05));
  });

  // Ensure mixer stops fully when component unmounts (Strict Mode safety).
  useEffect(() => {
    return () => {
      Object.values(actions).forEach((a) => a?.stop());
    };
  }, [actions]);

  // Half-size — Quaternius char is huge by default for the tile pitch.
  return (
    <group ref={groupRef} scale={0.5}>
      <primitive object={cloned} />
    </group>
  );
});

useGLTF.preload(ASSET);
