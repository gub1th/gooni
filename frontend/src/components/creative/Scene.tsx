import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, AdaptiveEvents, OrbitControls, useProgress } from "@react-three/drei";
import * as THREE from "three";
import { useNavigate } from "@tanstack/react-router";
import { Volume2, VolumeX, Activity } from "lucide-react";
import { Atmosphere } from "./Atmosphere";
import { SkyDome } from "./SkyDome";
import { Plaza } from "./Plaza";
import { Nature } from "./Nature";
import { Clouds } from "./Clouds";
import { NoteCoins } from "./NoteCoins";
import { DanielAvatar, type DanielHandle } from "./DanielAvatar";
import { NpcAvatar } from "./NpcAvatar";
import { LandingCamera } from "./LandingCamera";
import { IntroCamera, ORBIT_BASELINE } from "./IntroCamera";
import { NoteReaderOverlay } from "./NoteReaderOverlay";
import { NotePeekHost } from "./NotePeekHost";
import { Portal } from "./Portal";
import { PORTAL_TILE } from "./tileGrid";
import { setIdentity } from "./avatarIdentity";
import { setPeekState } from "./peekBus";
import { AmbientAudio } from "./AmbientAudio";
import { PostFX } from "./PostFX";
import { TileFloor } from "./TileFloor";
import { PerfSampler, type PerfMetrics } from "./PerfSampler";
import { Particles } from "./Particles";
import { TreeFader } from "./TreeFader";
import {
  queueHop,
  setCameraForward,
  setControlsEnabled,
  subscribeLandings,
  useDanielKeyboard,
} from "./useDanielControls";
import { setSfxMuted, playFall } from "./sfx";
import { fireVfx } from "./vfx";
import { useCountryFlag } from "./useCountryFlag";
import type { PublicNote } from "../../services/api";
import { FONT } from "../../ui";

const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

// Spec: FPS HUD hidden unless ?debug=true in the URL.
function useDebugFlag(): boolean {
  const [debug, setDebug] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const p = new URLSearchParams(window.location.search);
    return p.has("debug");
  });
  useEffect(() => {
    function onPop() {
      const p = new URLSearchParams(window.location.search);
      setDebug(p.has("debug"));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return debug;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.innerWidth < 768,
  );
  useEffect(() => {
    function onResize() {
      setMobile(window.innerWidth < 768);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mobile;
}

// Camera director — orbit target follow w/ Y damping + look-ahead pan
// in character's hop direction + landing shake + tile-break dip + auto-
// return to the default rear-3/4 offset after a couple seconds of idle.
function CameraDirector({
  controlsRef,
  danielRef,
  enabled,
}: {
  controlsRef: React.MutableRefObject<any>;
  danielRef: React.MutableRefObject<DanielHandle | null>;
  enabled: boolean;
}) {
  const followTargetRef = useRef(new THREE.Vector3());
  const cameraTargetYRef = useRef(0.7);
  const lookAheadRef = useRef(new THREE.Vector3());
  const shakeRef = useRef<{ amp: number; t: number; dur: number }>({ amp: 0, t: 0, dur: 0 });
  const dipRef = useRef<{ active: boolean; t: number }>({ active: false, t: 0 });
  const lastHopAtRef = useRef(0);
  const lastUserInteractRef = useRef(0);
  const wasHoppingRef = useRef(false);
  const initedRef = useRef(false);

  // Cardinal rear offset — matches ORBIT_BASELINE so the auto-return
  // settles at the same pose the intro lands on (no slow drift after
  // intro completes).
  const DEFAULT_OFFSET = new THREE.Vector3(0, 8, 10);
  const RETURN_DELAY_MS = 1100;
  const MIN_CAM_DIST = 7;

  useEffect(() => {
    const ctl = controlsRef.current;
    if (!ctl) return;
    function onStart() { lastUserInteractRef.current = performance.now(); }
    function onEnd() { lastUserInteractRef.current = performance.now(); }
    ctl.addEventListener("start", onStart);
    ctl.addEventListener("end", onEnd);
    return () => {
      ctl.removeEventListener("start", onStart);
      ctl.removeEventListener("end", onEnd);
    };
  }, [controlsRef.current]);

  useEffect(() => {
    return subscribeLandings((e) => {
      // Spec: 0.03 amp / 0.1s decay. Cap velocity hard so high hops
      // don't trigger an earthquake.
      const v = Math.min(e.impactVel, 8);
      if (v > 1.0) {
        shakeRef.current.amp = v * 0.004;
        shakeRef.current.t = 0;
        shakeRef.current.dur = 0.10;
      }
      if (e.from && !e.fellOff) {
        dipRef.current.active = true;
        dipRef.current.t = 0;
      }
    });
  }, []);

  const tmp = useRef(new THREE.Vector3()).current;
  const tmpShake = useRef(new THREE.Vector3()).current;
  const tmpDesired = useRef(new THREE.Vector3()).current;

  useFrame((_, rawDt) => {
    if (!enabled) {
      initedRef.current = false;
      return;
    }
    const ctl = controlsRef.current;
    const d = danielRef.current;
    if (!ctl || !d?.group) return;
    const dt = Math.min(rawDt, 0.05);

    d.group.getWorldPosition(tmp);

    // First frame after enable: snap internal state to current ctl.target +
    // char pos so there's no lerp from (0,0,0) to baseline.
    if (!initedRef.current) {
      cameraTargetYRef.current = ctl.target.y;
      followTargetRef.current.copy(ctl.target);
      lookAheadRef.current.set(0, 0, 0);
      initedRef.current = true;
    }

    // During fall-off / sky-respawn / lying, don't track the char's Y —
    // the char is either far below the world or way above it. Anchor
    // the camera at the gameplay pose around plaza center so the player
    // doesn't lose orientation. Resume normal tracking once char hits
    // the idle phase post-get-up.
    const phase = d.phase();
    const isRespawnPhase =
      phase === "falling" || phase === "respawning" ||
      phase === "lying" || phase === "getting-up";
    if (isRespawnPhase) {
      ctl.target.lerp(new THREE.Vector3(0, 0.6, 0), 0.04);
      tmpDesired.set(0, 8, 10);
      ctl.object.position.lerp(tmpDesired, 0.03);
      ctl.update();
      return;
    }

    cameraTargetYRef.current += ((tmp.y + 0.7) - cameraTargetYRef.current) * 0.04;

    const heading = d.heading();
    const hopping = d.isHopping();
    if (hopping && !wasHoppingRef.current) lastHopAtRef.current = performance.now();
    wasHoppingRef.current = hopping;

    // Look-ahead during hop, ease back to 0 when idle.
    const ax = hopping ? Math.sin(heading) * 1.2 : 0;
    const az = hopping ? Math.cos(heading) * 1.2 : 0;
    lookAheadRef.current.x += (ax - lookAheadRef.current.x) * 0.05;
    lookAheadRef.current.z += (az - lookAheadRef.current.z) * 0.05;

    followTargetRef.current.set(
      tmp.x + lookAheadRef.current.x,
      cameraTargetYRef.current,
      tmp.z + lookAheadRef.current.z,
    );
    ctl.target.lerp(followTargetRef.current, 0.16);

    // Auto-return to default offset behind character once idle for a
    // moment. Any user orbit interaction cancels.
    const now = performance.now();
    const sinceHop = now - lastHopAtRef.current;
    const sinceUser = now - lastUserInteractRef.current;
    if (!hopping && sinceHop > RETURN_DELAY_MS && sinceUser > RETURN_DELAY_MS) {
      tmpDesired.copy(tmp).add(DEFAULT_OFFSET);
      ctl.object.position.lerp(tmpDesired, 0.025);
    }

    // Landing shake
    const sh = shakeRef.current;
    if (sh.amp > 0 && sh.t < sh.dur) {
      sh.t += dt;
      const u = sh.t / sh.dur;
      const amp = sh.amp * (1 - u);
      tmpShake.set(
        (Math.random() - 0.5) * amp * 2,
        (Math.random() - 0.5) * amp * 1.2,
        (Math.random() - 0.5) * amp * 2,
      );
      ctl.object.position.add(tmpShake);
      ctl.target.add(tmpShake);
    }

    const dp = dipRef.current;
    if (dp.active) {
      dp.t += dt;
      const u = dp.t / 0.18;
      if (u >= 1) { dp.active = false; }
      else {
        const off = Math.sin(u * Math.PI) * 0.025;
        ctl.object.position.y -= off;
      }
    }

    // Hard min distance from character — push camera back along its
    // current target→camera direction if the lerp pulled it too close.
    const camPos = ctl.object.position;
    const dx = camPos.x - tmp.x;
    const dy = camPos.y - tmp.y;
    const dz = camPos.z - tmp.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < MIN_CAM_DIST && dist > 0.001) {
      const k = MIN_CAM_DIST / dist;
      camPos.x = tmp.x + dx * k;
      camPos.z = tmp.z + dz * k;
      if (dy < 2.2) camPos.y = tmp.y + 2.2;
    }

    ctl.update();
  });

  return null;
}

function CameraForwardTracker() {
  const { camera } = useThree();
  const tmp = useRef(new THREE.Vector3()).current;
  useFrame(() => {
    camera.getWorldDirection(tmp);
    setCameraForward(tmp.x, tmp.z);
  });
  return null;
}

// Player identity collected at the StartOverlay before drop-in.
const DEFAULT_PLAYER_COLOR = "#4ade80";
const DEFAULT_PLAYER_NAME = "too lazy";

export function Scene() {
  const mobile = useIsMobile();
  const debug = useDebugFlag();
  const navigate = useNavigate();
  // Drop-through-the-hole transition into the walk.
  const [dropping, setDropping] = useState(false);
  // Where the player is standing. Drives the portal prompt and the
  // scripted camera — both need to engage on approach and let go the
  // moment the player walks off, so they can't be one-shot effects.
  const [playerGrid, setPlayerGrid] = useState<{ gx: number; gz: number } | null>(null);
  const [entered, setEntered] = useState(false);
  const [swoopLanded, setSwoopLanded] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const [overlayMounted, setOverlayMounted] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  // The scripted auto-jump + camera pan into the close-up. While it runs the
  // player can't steer (it's ~1.5s). It only starts once the welcome modal
  // is closed via ↑ / the X / clicking out — NOT on a sideways key.
  const [autoJumping, setAutoJumping] = useState(false);
  const [muted, setMuted] = useState(false);
  const [perfOpen, setPerfOpen] = useState(true);
  const [perf, setPerf] = useState<PerfMetrics>({ fps: 0, ms: 0, draws: 0, tris: 0 });
  const [selectedNote, setSelectedNote] = useState<PublicNote | null>(null);
  const [playerName, setPlayerName] = useState(DEFAULT_PLAYER_NAME);
  const [playerColor, setPlayerColor] = useState(DEFAULT_PLAYER_COLOR);
  const countryFlag = useCountryFlag();

  const orbitRef = useRef<any>(null);
  const danielRef = useRef<DanielHandle | null>(null);

  useDanielKeyboard();

  useEffect(() => {
    // Steering is off while the welcome modal is up AND during the scripted
    // auto-jump pan — the character only obeys the player once both clear.
    setControlsEnabled(introDone && !selectedNote && !showWelcome && !autoJumping);
  }, [introDone, selectedNote, showWelcome, autoJumping]);

  // Scripted intro auto-hop. The character spawns two tiles back from the
  // hole and stands up there — that beat is the scene-setter. Then, a
  // moment later, it hops itself one tile forward onto the lip, which
  // trips `nearPortal` and frames the close-up (ApproachCamera + the
  // "Jump in?" prompt) without the player having to find the arrow keys
  // first. The avatar only consumes the queued hop once it's idle and
  // controllable, so this can't fire mid-get-up. introDone latches
  // true once, so the timer runs exactly once.
  // Welcome modal pops once the intro settles — it carries the greeting +
  // controls + the choice of paths. Nothing auto-moves until it closes.
  useEffect(() => {
    if (introDone) setShowWelcome(true);
  }, [introDone]);

  // How the modal was closed decides what happens next:
  //   ↑ / X / click-out → scripted auto-jump forward into the close-up
  //   ↓ / ← / →         → just move that way, normally
  const handleWelcomeClose = (key?: string) => {
    setShowWelcome(false);
    if (!key || key === "ArrowUp") {
      // Forward. Lock steering, then fire the hop AFTER a half-second beat.
      // The delay is deliberate (a breath before it moves) AND load-bearing:
      // flipping autoJumping calls setControlsEnabled(false), which CLEARS
      // the input queue — firing queueHop immediately got wiped, so the
      // auto-jump never happened. Queue it after that clear instead.
      setAutoJumping(true);
      // Near-immediate. The tiny delay only clears the input queue after
      // setControlsEnabled(false) runs (a 0 would race it); it reads as instant.
      window.setTimeout(() => {
        queueHop("up");
        window.setTimeout(() => setAutoJumping(false), 1400);
      }, 60);
    } else {
      const dir = key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : "right";
      queueHop(dir);
    }
  };

  useEffect(() => {
    setSfxMuted(muted);
  }, [muted]);

  // Spec Phase 4: "small poof particle burst at center tile" when the
  // character appears post-impact.
  useEffect(() => {
    if (swoopLanded) {
      fireVfx({
        kind: "puff",
        world: { x: 0, y: 0.15, z: 0 },
        intensity: 1.0,
      });
    }
  }, [swoopLanded]);

  const dprMax = typeof window === "undefined"
    ? 1.5
    : Math.min(window.devicePixelRatio ?? 1, 2);

  function handleSelect(note: PublicNote, _worldPos: THREE.Vector3) {
    // Reader is a fullscreen DOM overlay — moving the camera does
    // nothing visible while it's open and only produces a jarring
    // snap when it closes. Just open the reader. Also clear the peek
    // bar so it doesn't pop back over the same coin once the reader
    // closes — re-landing is the way to bring peek back.
    setSelectedNote(note);
    setPeekState({ note: null });
  }

  useEffect(() => {
    return subscribeLandings((e) => {
      if (e.actor !== "player") return;
      setPlayerGrid(e.fellOff ? null : { gx: e.gx, gz: e.gz });
    });
  }, []);

  function handleClose() {
    setSelectedNote(null);
  }

  function handleEnter(name: string, color: string) {
    setPlayerName(name);
    setPlayerColor(color);
    // Carried across the drop so the walk is walked by the same
    // character, not a stranger in the default green.
    setIdentity(name, color);
    setEntered(true);
    setTimeout(() => setOverlayMounted(false), 720);
  }

  // No nickname/pause gate. Show the bird's-eye briefly, then drop in
  // automatically with the default identity — the user's nametag is hidden
  // anyway, so there's nothing to collect. (The StartOverlay component is
  // kept for reference but no longer mounted.)
  useEffect(() => {
    const t = window.setTimeout(() => handleEnter(DEFAULT_PLAYER_NAME, DEFAULT_PLAYER_COLOR), 1300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One tile away, orthogonally. Diagonals are excluded on purpose:
  // from a diagonal you can't hop straight in, so promising "jump in"
  // there would be a lie.
  const nearPortal =
    playerGrid !== null &&
    !dropping &&
    Math.abs(playerGrid.gx - PORTAL_TILE.gx) + Math.abs(playerGrid.gz - PORTAL_TILE.gz) === 1;

  // The scripted camera takes the wheel on approach, so the free
  // director has to stand down or the two fight frame by frame.
  const orbitEnabled =
    introDone && !selectedNote && !nearPortal && !dropping && !showWelcome && !autoJumping;
  // Char mounts only AFTER the camera reaches impact pose (swoopLanded).
  // Before that, the player sees an empty plaza while the camera drops
  // in — so the get-up isn't visible mid-camera-spin. Spec Phase 4:
  // "Character appears ONLY after camera reaches ground level."
  const showCharacter = swoopLanded;

  return (
    <>
      <Canvas
        shadows={!mobile}
        dpr={[1, dprMax]}
        camera={{ position: [4.5, 17, 0], fov: 56, near: 0.05, far: 280 }}
        // Set camera lookAt before first paint so the landing bird's-eye
        // shows up clean — matches the LandingCamera t=0 pose so frame 0
        // paints with the correct directly-above orientation.
        onCreated={({ camera }) => {
          camera.position.set(4.5, 17, 0);
          camera.lookAt(0, 0, 0);
          camera.updateProjectionMatrix();
        }}
        gl={{
          antialias: !mobile,
          powerPreference: "high-performance",
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.0,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
      >
        <SkyDome />
        <Atmosphere mobile={mobile} />
        <Plaza />
        <TileFloor />
        <Nature />
        <Clouds />
        <Particles />

        {showCharacter && (
          <DanielAvatar
            ref={danielRef}
            active={entered}
            introTrigger={swoopLanded}
            controllable={introDone && !selectedNote}
            onIntroComplete={() => setIntroDone(true)}
            name={playerName}
            bodyColor={playerColor}
            showNametag={false}
            flag={countryFlag}
          />
        )}
        <NpcAvatar
          startGx={3}
          startGz={-2}
          name="goonie"
          showNametag={false}
          bodyColor="#5aa6ff"
          accentColor="#3d7fcc"
          initialDelayMs={600}
        />
        {entered && introDone && <NoteCoins onSelect={handleSelect} />}
        {/* The way into the walk. The landmark system that used to sit
            here is superseded by it — the plaza is the front door now,
            and the portfolio content lives on the other side of this
            hole rather than being duplicated around the island. */}
        {entered && (
          <Portal armed={!dropping} near={nearPortal} onEnter={() => setDropping(true)} />
        )}
        <ApproachCamera active={nearPortal} />
        <DropCamera
          active={dropping}
          onDone={() => navigate({ to: "/walk" })}
        />

        {/* Landing bird's-eye — runs while overlay is up; hands off to
            IntroCamera on click. */}
        <LandingCamera active={!entered} />

        <IntroCamera
          active={entered && !introDone}
          onSwoopLanded={() => setSwoopLanded(true)}
          onComplete={() => setIntroDone(true)}
          externalTarget={null}
        />

        <OrbitControls
          ref={orbitRef}
          enabled={orbitEnabled}
          target={ORBIT_BASELINE.target.toArray()}
          enablePan={false}
          minDistance={ORBIT_BASELINE.minDistance}
          maxDistance={ORBIT_BASELINE.maxDistance}
          minPolarAngle={Math.PI * 0.16}
          maxPolarAngle={Math.PI * 0.46}
          rotateSpeed={0.6}
          zoomSpeed={0.6}
          autoRotate={false}
          makeDefault
        />
        <CameraDirector controlsRef={orbitRef} danielRef={danielRef} enabled={orbitEnabled} />
        <CameraForwardTracker />
        <TreeFader targetRef={danielRef} />

        <AdaptiveDpr pixelated />
        <AdaptiveEvents />
        <PostFX mobile={mobile} />
        {debug && <PerfSampler onSample={setPerf} />}
      </Canvas>

      {introDone && !selectedNote && <NavHint />}

      <div style={{ position: "fixed", top: 22, right: 22, display: "flex", gap: 10, zIndex: 8 }}>
        {entered && debug && (
          <PerfToggle open={perfOpen} onToggle={() => setPerfOpen((v) => !v)} />
        )}
        <MuteToggle muted={muted} onToggle={() => setMuted(!muted)} entered={entered} />
      </div>
      {entered && debug && perfOpen && <PerfPanel metrics={perf} />}

      {overlayMounted && (
        <StartOverlay
          onEnter={handleEnter}
          leaving={entered}
          defaultName={DEFAULT_PLAYER_NAME}
          defaultColor={DEFAULT_PLAYER_COLOR}
        />
      )}
      {entered && <AmbientAudio muted={muted} />}

      <NoteReaderOverlay
        noteId={selectedNote?.id ?? null}
        onClose={handleClose}
      />

      {entered && introDone && !selectedNote && <NotePeekHost />}

      {/* Retro prompt. Appears only while the player is standing beside
          the hole, the way an era-appropriate game puts the instruction
          in a box at the bottom of the screen rather than floating it
          in world space. */}
      <PromptBox visible={nearPortal} />

      {showWelcome && <WelcomeModal onClose={handleWelcomeClose} />}

      {/* The fade. Deliberately late and fast: the jump plays, the beat
          holds, THEN the screen goes dark — that ordering is what makes
          it read as a cutscene rather than as a page transition. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: "#05070A",
          opacity: dropping ? 1 : 0,
          // Eases in under the dive so the last of the light fades as the
          // camera reaches the bottom of the shaft — finishes, not cuts.
          transition: "opacity 600ms ease 600ms",
          pointerEvents: "none",
          zIndex: 40,
        }}
      />
      {entered && <BrandingMark />}
      {entered && <ShortVersionLink visible={introDone && !selectedNote} />}
    </>
  );
}

// The permanent way out. A reviewer with two minutes should never have
// to walk the island to find out what he's done — this pill is pinned
// top-left the whole time and lands on the flat page.
//
// Pointed at /public/cv rather than /public: the notes index is a
// reading surface, not a summary, so it answered the wrong question for
// someone scanning. Notes stay reachable from the flat page's footer.
// One escape hatch, not two — a second pill would be clutter on a
// surface whose whole argument is subtraction.
function ShortVersionLink({ visible }: { visible: boolean }) {
  return (
    <a
      href="/public/cv"
      style={{
        position: "fixed",
        top: 22,
        left: 22,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 16px 9px 14px",
        borderRadius: 999,
        // Glass pill on the 3D scene — matches MuteToggle/PerfToggle
        // styling so the top-corner cluster reads as one family. No
        // shadow saturation; quiet but legible.
        background: "rgba(255,255,255,0.86)",
        color: "#1a1a1a",
        textDecoration: "none",
        fontFamily: FONT,
        fontSize: 13,
        fontWeight: 500,
        letterSpacing: "0.01em",
        border: "1px solid rgba(0,0,0,0.06)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)",
        backdropFilter: "blur(14px) saturate(160%)",
        WebkitBackdropFilter: "blur(14px) saturate(160%)",
        zIndex: 8,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(-8px)",
        transition: "opacity 320ms ease, transform 200ms ease, background 180ms ease",
        pointerEvents: visible ? "auto" : "none",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.background = "rgba(255,255,255,0.96)";
        el.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.background = "rgba(255,255,255,0.86)";
        el.style.transform = "translateY(0)";
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "#1b8b4a",
          boxShadow: "0 0 0 3px rgba(74,222,128,0.20)",
        }}
      />
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "#E1F5EE",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <NotebookIcon />
      </span>
      <span>view cv</span>
      <span style={{ fontSize: 14, lineHeight: 1, marginLeft: 1, color: "#555" }}>↗</span>
    </a>
  );
}

function NotebookIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3.5" y="2" width="9" height="12" rx="1.2" stroke="#1D9E75" strokeWidth="1.3" />
      <path d="M3.5 5h9M3.5 8h6M3.5 11h6" stroke="#1D9E75" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function BrandingMark() {
  return (
    <a
      href="/"
      style={{
        position: "fixed",
        bottom: 14,
        left: 16,
        color: "#ffffff",
        opacity: 0.30,
        textDecoration: "none",
        fontFamily: FONT,
        fontSize: 13,
        letterSpacing: "0.06em",
        zIndex: 6,
        textShadow: "0 1px 6px rgba(0,0,0,0.55)",
        transition: "opacity 200ms ease",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.opacity = "0.85"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.opacity = "0.30"; }}
    >
      gooni
    </a>
  );
}

const SWATCHES = [
  "#4ade80",  // default green
  "#5aa6ff",
  "#ffc14d",
  "#ff6f8d",
  "#a36cff",
  "#ff8a4d",
];

function StartOverlay({
  onEnter,
  leaving,
  defaultName,
  defaultColor,
}: {
  onEnter: (name: string, color: string) => void;
  leaving: boolean;
  defaultName: string;
  defaultColor: string;
}) {
  const { progress, active } = useProgress();
  const ready = !active || progress >= 99;
  const [titleHovered, setTitleHovered] = useState(false);
  const [readHovered, setReadHovered] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(defaultColor);

  function submit() {
    if (!ready) return;
    onEnter(name.trim() || defaultName, color);
  }

  return (
    <div
      onClick={submit}
      style={{
        position: "fixed",
        inset: 0,
        background:
          "linear-gradient(180deg, rgba(20,28,48,0.05) 0%, rgba(20,28,48,0.55) 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: "14vh",
        gap: 18,
        color: "#fff",
        fontFamily: FONT,
        zIndex: 10,
        opacity: leaving ? 0 : 1,
        pointerEvents: leaving ? "none" : "auto",
        transition: "opacity 700ms ease-out",
      }}
    >
      <div
        onMouseEnter={() => setTitleHovered(true)}
        onMouseLeave={() => setTitleHovered(false)}
        style={{
          fontFamily: DISPLAY,
          fontSize: 48,
          letterSpacing: "-0.6px",
          textShadow: titleHovered
            ? "0 2px 28px rgba(255,228,140,0.55), 0 0 40px rgba(255,228,140,0.35)"
            : "0 2px 28px rgba(0,0,0,0.55), 0 0 40px rgba(180,200,235,0.22)",
          transform: leaving ? "translateY(-8px)" : "translateY(0)",
          transition: "transform 700ms ease-out, color 280ms ease, text-shadow 280ms ease",
          animation: leaving ? undefined : "plaza-float-title 5.5s ease-in-out infinite",
          willChange: "transform, opacity",
          position: "relative",
          color: titleHovered ? "#ffe79a" : "#ffffff",
        }}
      >
        daniel's plaza
      </div>

      {ready ? (
        <>
          <input
            type="text"
            value={name}
            placeholder="enter your nickname"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            maxLength={20}
            autoFocus
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#fff",
              textAlign: "center",
              fontSize: 18,
              fontFamily: FONT,
              width: 320,
              padding: "8px 4px",
              caretColor: "rgba(255,255,255,0.9)",
              textShadow: "0 1px 8px rgba(0,0,0,0.5)",
            }}
          />
          <style>{`input::placeholder { color: rgba(255,255,255,0.55); font-style: italic; letter-spacing: 0.02em; }`}</style>

          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 9 }}>
            {SWATCHES.map((c) => (
              <button
                key={c}
                onClick={(e) => { e.stopPropagation(); setColor(c); }}
                aria-label={`pick color ${c}`}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: c,
                  border: color === c ? "2px solid rgba(255,255,255,0.95)" : "2px solid rgba(255,255,255,0.15)",
                  cursor: "inherit",
                  padding: 0,
                  boxShadow: color === c ? `0 0 12px ${c}80` : "none",
                  transition: "border 160ms ease, box-shadow 160ms ease",
                }}
              />
            ))}
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); submit(); }}
            style={{
              position: "relative",
              background: "transparent",
              border: "none",
              outline: "none",
              color: "rgba(255,255,255,0.95)",
              fontSize: 14,
              fontFamily: FONT,
              letterSpacing: "0.06em",
              padding: "10px 22px",
              cursor: "inherit",
              marginTop: 6,
              animation: "plaza-cta-glow 2.8s ease-in-out infinite",
              textShadow: "0 1px 8px rgba(0,0,0,0.4)",
              borderRadius: 999,
            }}
          >
            click or press enter to drop in
            <span style={{
              position: "absolute",
              inset: 0,
              borderRadius: 999,
              pointerEvents: "none",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.18) inset",
              animation: "plaza-cta-ring 2.8s ease-in-out infinite",
            }} />
          </button>

          {/* Quiet secondary path: skip the 3D plaza, read the notebook
              directly. Plain anchor (full nav) so the Canvas tears down.
              stopPropagation keeps the overlay-wide submit from firing. */}
          <a
            href="/public/"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseEnter={() => setReadHovered(true)}
            onMouseLeave={() => setReadHovered(false)}
            style={{
              marginTop: 2,
              fontSize: 12.5,
              fontFamily: FONT,
              letterSpacing: "0.04em",
              color: readHovered ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.5)",
              textDecoration: "none",
              textShadow: "0 1px 8px rgba(0,0,0,0.5)",
              cursor: "inherit",
              transition: "color 200ms ease",
            }}
          >
            or just read the notes →
          </a>
        </>
      ) : (
        <>
          <div
            style={{
              fontSize: 14,
              textShadow: "0 1px 12px rgba(0,0,0,0.6)",
              animation: "plaza-pulse-sub 3.6s ease-in-out infinite",
            }}
          >
            preparing the plaza…
          </div>
          <div style={{
            width: 220,
            height: 2,
            background: "rgba(255,255,255,0.18)",
            borderRadius: 999,
            overflow: "hidden",
            marginTop: 4,
          }}>
            <div style={{
              width: `${Math.max(2, progress)}%`,
              height: "100%",
              background: "rgba(255,255,255,0.92)",
              transition: "width 280ms ease",
            }} />
          </div>
        </>
      )}

      <style>{`
        @keyframes plaza-float-title {
          0%   { transform: translateY(0px);    opacity: 1; }
          50%  { transform: translateY(-7px);   opacity: 0.94; }
          100% { transform: translateY(0px);    opacity: 1; }
        }
        @keyframes plaza-pulse-sub {
          0%   { opacity: 0.78; }
          50%  { opacity: 1.0; }
          100% { opacity: 0.78; }
        }
        @keyframes plaza-cta-glow {
          0%   { transform: translateY(0px) scale(1.0);    text-shadow: 0 1px 8px rgba(0,0,0,0.4); }
          50%  { transform: translateY(-3px) scale(1.02);  text-shadow: 0 1px 10px rgba(255,228,140,0.55), 0 0 24px rgba(255,228,140,0.35); }
          100% { transform: translateY(0px) scale(1.0);    text-shadow: 0 1px 8px rgba(0,0,0,0.4); }
        }
        @keyframes plaza-cta-ring {
          0%   { box-shadow: 0 0 0 1px rgba(255,255,255,0.10) inset, 0 0 0 0 rgba(255,228,140,0.0); }
          50%  { box-shadow: 0 0 0 1px rgba(255,255,255,0.28) inset, 0 0 14px 2px rgba(255,228,140,0.25); }
          100% { box-shadow: 0 0 0 1px rgba(255,255,255,0.10) inset, 0 0 0 0 rgba(255,228,140,0.0); }
        }
      `}</style>
    </div>
  );
}

function MuteToggle({ muted, onToggle, entered }: { muted: boolean; onToggle: () => void; entered: boolean }) {
  if (!entered) return null;
  return (
    <button
      onClick={onToggle}
      aria-label={muted ? "Unmute" : "Mute"}
      title={muted ? "Unmute" : "Mute"}
      style={{
        background: "rgba(255,255,255,0.86)",
        border: "1px solid rgba(0,0,0,0.06)",
        borderRadius: 999,
        width: 40,
        height: 40,
        cursor: "pointer",
        boxShadow: "0 4px 14px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(14px) saturate(160%)",
        WebkitBackdropFilter: "blur(14px) saturate(160%)",
        transition: "background 180ms ease, transform 120ms ease",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = "rgba(255,255,255,0.96)";
        el.style.transform = "scale(1.04)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = "rgba(255,255,255,0.86)";
        el.style.transform = "scale(1.0)";
      }}
    >
      {muted ? <VolumeX size={17} color="#2a2a2a" strokeWidth={1.8} /> : <Volume2 size={17} color="#2a2a2a" strokeWidth={1.8} />}
    </button>
  );
}

function PerfToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={open ? "Hide perf stats" : "Show perf stats"}
      title="Toggle perf stats"
      style={{
        background: open ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.78)",
        border: "1px solid rgba(0,0,0,0.06)",
        borderRadius: 999,
        width: 40,
        height: 40,
        cursor: "pointer",
        boxShadow: "0 4px 14px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(14px) saturate(160%)",
        WebkitBackdropFilter: "blur(14px) saturate(160%)",
        transition: "background 180ms ease, transform 120ms ease",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.04)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.0)";
      }}
    >
      <Activity size={17} color="#2a2a2a" strokeWidth={1.8} />
    </button>
  );
}

// Thresholds + color picker for the perf HUD. Green = healthy, yellow
// = borderline, red = bad. Tuned for a small 3D scene like this.
function fpsColor(v: number): string {
  if (v >= 55) return "#1aa863";
  if (v >= 30) return "#d9a217";
  return "#cc3a3a";
}
function msColor(v: number): string {
  if (v <= 18) return "#1aa863";
  if (v <= 33) return "#d9a217";
  return "#cc3a3a";
}
function drawsColor(v: number): string {
  if (v <= 80) return "#1aa863";
  if (v <= 200) return "#d9a217";
  return "#cc3a3a";
}
function trisColor(v: number): string {
  if (v <= 100000) return "#1aa863";
  if (v <= 300000) return "#d9a217";
  return "#cc3a3a";
}

function PerfPanel({ metrics }: { metrics: PerfMetrics }) {
  const rows: { label: string; value: string; color: string }[] = [
    { label: "fps",   value: String(metrics.fps),                            color: fpsColor(metrics.fps) },
    { label: "ms",    value: String(metrics.ms),                             color: msColor(metrics.ms) },
    { label: "draws", value: String(metrics.draws),                          color: drawsColor(metrics.draws) },
    { label: "tris",  value: formatThousands(metrics.tris),                  color: trisColor(metrics.tris) },
  ];
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 72,
        right: 22,
        background: "rgba(255,255,255,0.92)",
        border: "1px solid rgba(0,0,0,0.06)",
        borderRadius: 12,
        padding: "10px 14px",
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: 12,
        color: "#2a2a2a",
        boxShadow: "0 6px 18px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)",
        backdropFilter: "blur(14px) saturate(160%)",
        WebkitBackdropFilter: "blur(14px) saturate(160%)",
        zIndex: 8,
        minWidth: 120,
        pointerEvents: "none",
      }}
    >
      {rows.map((r) => (
        <div
          key={r.label}
          style={{ display: "flex", justifyContent: "space-between", gap: 14, lineHeight: 1.55 }}
        >
          <span style={{ color: "#888" }}>{r.label}</span>
          <span style={{ color: r.color, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatThousands(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function NavHint() {
  // Spec: appear AFTER 2s of no-input post-introDone, fade on first
  // input, never show again.
  const [visible, setVisible] = useState(false);
  const dismissedRef = useRef(false);
  useEffect(() => {
    function dismiss() {
      dismissedRef.current = true;
      setVisible(false);
    }
    window.addEventListener("keydown", dismiss);
    window.addEventListener("pointerdown", dismiss);
    const showTimer = setTimeout(() => {
      if (!dismissedRef.current) setVisible(true);
    }, 2000);
    const hideTimer = setTimeout(() => setVisible(false), 11000);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("pointerdown", dismiss);
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, []);
  if (!visible) return null;
  return (
    <div style={{
      position: "fixed",
      bottom: 28,
      left: "50%",
      transform: "translateX(-50%)",
      color: "rgba(40,40,50,0.78)",
      fontSize: 12.5,
      letterSpacing: "0.04em",
      fontFamily: FONT,
      background: "rgba(255,255,255,0.72)",
      padding: "7px 16px",
      borderRadius: 999,
      backdropFilter: "blur(6px)",
      pointerEvents: "none",
      zIndex: 5,
      whiteSpace: "nowrap",
      boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
    }}>
      arrows to hop · drag to orbit · land on a coin to peek, click to read
    </div>
  );
}


// The drop — a smooth DIVE into the hole. The static "hold, then black"
// read goofy: the shaft looked like a lone black pillar and the character
// just sat visible on it. Instead the camera plunges toward + down INTO
// the opening, tilting to follow the sinking character down the shaft, so
// the frame naturally fills with the shaft's darkness. The veil only
// finishes the fade.
//
//   camera eases to just over the rim, look-point descends into the shaft
//   → the character sinks ahead of it → darkness → navigate.
const DROP_MS = 1250;

function DropCamera({ active, onDone }: { active: boolean; onDone: () => void }) {
  const start = useRef<number | null>(null);
  const held = useRef(new THREE.Vector3());
  const heldFov = useRef(56);
  const fired = useRef(false);

  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    if (!active) {
      start.current = null;
      fired.current = false;
      return;
    }
    if (start.current === null) {
      start.current = performance.now();
      held.current.copy(cam.position);
      heldFov.current = cam.fov;
      // Take the wheel so OrbitControls/CameraDirector can't fight it.
      setControlsEnabled(false);
      playFall();
    }
    const t = Math.min(1, (performance.now() - start.current) / DROP_MS);
    const e = t * t; // accelerate, like gravity
    // FREEFALL: the frame falls, not a sprite down a box. The camera plunges
    // straight down over the hole while the FOV widens, so the shaft walls
    // rush up past you — reads as falling, not as staring into a black box.
    cam.position.set(0, held.current.y - 16 * e, -4 + (held.current.z + 4) * (1 - e));
    cam.lookAt(0, held.current.y - 16 * e - 4, -4);
    cam.fov = heldFov.current + 26 * e;
    cam.updateProjectionMatrix();
    if (t >= 1 && !fired.current) {
      fired.current = true;
      onDone();
    }
  });

  return null;
}

// Scripted framing on approach. Uses a FIXED close-up pose (the char sits at
// (0,-1) → world (0,·,-2), hole at (0,-2) → world (0,·,-4)), NOT the live
// character position — following the character coupled the camera to its
// hop/settle bob, which read as jitter + "the jump moves the camera up".
const APPROACH_POS = new THREE.Vector3(-2.6, 2.6, 0.7);
const APPROACH_LOOK = new THREE.Vector3(0.6, 1.1, -3.6);
function ApproachCamera({ active }: { active: boolean }) {
  const look = useRef(new THREE.Vector3());
  const inited = useRef(false);
  const fwd = useRef(new THREE.Vector3());

  useFrame((state, rawDt) => {
    if (!active) {
      inited.current = false;
      return;
    }
    const dt = Math.min(rawDt, 0.05);
    if (!inited.current) {
      inited.current = true;
      // Ease the look from wherever the camera currently points, so the pan
      // glides instead of snapping.
      state.camera.getWorldDirection(fwd.current);
      look.current.copy(state.camera.position).addScaledVector(fwd.current, 4);
    }
    state.camera.position.lerp(APPROACH_POS, Math.min(1, dt * 2.2));
    look.current.lerp(APPROACH_LOOK, Math.min(1, dt * 2.2));
    state.camera.lookAt(look.current);
  });

  return null;
}

// Bottom-of-screen instruction box.
const PIXEL_FONT = "'Press Start 2P', ui-monospace, monospace";

// Little key-cap glyphs (arrows aren't in Press Start 2P, so these render in
// a system font inside a cap).
function KeyCap({ ch }: { ch: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        lineHeight: 1,
        background: "#fff",
        border: "2px solid #2E2418",
        borderRadius: 5,
        padding: "2px 5px",
        margin: "0 2px",
        color: "#2E7D57",
      }}
    >
      {ch}
    </span>
  );
}

// The landing greeting + wayfinding, as a paper modal (no black border). It
// HOLDS everything — nothing auto-moves until it closes. How it closes drives
// what happens next (↑/X/click-out → forward jump; ↓←→ → move that way),
// handled by the parent's onClose.
function WelcomeModal({ onClose }: { onClose: (key?: string) => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true)); // fade IN
    return () => cancelAnimationFrame(r);
  }, []);
  // Fade OUT, then hand off to the parent (which starts the jump after its
  // own short beat).
  const close = useCallback(
    (key?: string) => {
      setShown(false);
      window.setTimeout(() => onClose(key), 170);
    },
    [onClose],
  );
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        close(e.key);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => close()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,16,10,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 20,
        opacity: shown ? 1 : 0,
        transition: "opacity 200ms ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: "min(470px, 100%)",
          background: "#FBF4E2",
          borderRadius: 16,
          padding: "34px 30px 28px",
          boxShadow: "0 22px 60px rgba(0,0,0,0.35)",
          fontFamily: PIXEL_FONT,
          color: "#2E2418",
          textAlign: "center",
          opacity: shown ? 1 : 0,
          transform: shown ? "scale(1)" : "scale(0.95)",
          transition: "opacity 200ms ease, transform 200ms cubic-bezier(0.2,0.8,0.3,1)",
        }}
      >
        <button
          onClick={() => close()}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 10,
            right: 12,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontFamily: "system-ui, sans-serif",
            fontSize: 22,
            lineHeight: 1,
            color: "#6B4E2E",
          }}
        >
          ×
        </button>

        <div style={{ fontSize: 15, color: "#2E7D57", lineHeight: 1.7, marginBottom: 22 }}>
          WELCOME TO
          <br />
          GOONI&apos;S PLAZA
        </div>

        <div style={{ fontSize: 10, lineHeight: 2, color: "#3a3226" }}>
          MOVE WITH
          <div style={{ marginTop: 10 }}>
            <KeyCap ch="↑" />
            <KeyCap ch="↓" />
            <KeyCap ch="←" />
            <KeyCap ch="→" />
          </div>
        </div>

        {/* Primary CTA — the interactive path. Closing forward runs the
            scripted auto-jump (same as ↑ / X / click-out). */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            marginTop: 28,
            fontFamily: PIXEL_FONT,
            fontSize: 11,
            color: "#FBF4E2",
            background: "#2E7D57",
            padding: "15px 22px",
            border: "none",
            borderRadius: 10,
            cursor: "pointer",
            lineHeight: 1.4,
            boxShadow: "0 6px 16px rgba(46,125,87,0.35)",
          }}
        >
          JUMP FORWARD <KeyCap ch="↑" /> TO EXPLORE
        </button>

        {/* Secondary — clearly a link. */}
        <div style={{ marginTop: 18 }}>
          <a
            href="/public/cv"
            onClick={(e) => e.stopPropagation()}
            style={{
              fontFamily: PIXEL_FONT,
              fontSize: 9,
              color: "#6B4E2E",
              textDecoration: "underline",
              textUnderlineOffset: 4,
              cursor: "pointer",
            }}
          >
            or view cv
          </a>
        </div>
      </div>
    </div>
  );
}

function PromptBox({ visible }: { visible: boolean }) {
  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        bottom: 34,
        transform: `translateX(-50%) translateY(${visible ? 0 : 16}px)`,
        zIndex: 30,
        width: "min(600px, calc(100vw - 40px))",
        // Dark frosted card — matches the note-peek theme; keeps the pixel font.
        background: "rgba(16,20,18,0.82)",
        backdropFilter: "blur(20px) saturate(140%)",
        WebkitBackdropFilter: "blur(20px) saturate(140%)",
        border: "1px solid rgba(242,239,232,0.14)",
        boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
        borderRadius: 16,
        padding: "16px 22px",
        fontFamily: PIXEL_FONT,
        fontSize: 12,
        color: "rgba(242,239,232,0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        letterSpacing: "0.01em",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transition: "opacity 260ms ease, transform 260ms ease",
      }}
    >
      {/* Single interactive CTA. The static-page route lives on the
          persistent top-left switch, so it is NOT repeated here. */}
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        Jump in to learn more
        <span
          aria-hidden
          style={{
            marginLeft: 12,
            fontSize: 18,
            lineHeight: 1,
            color: "#4ADE80",
            animation: "gooniBlink 0.85s steps(2, start) infinite",
          }}
        >
          !
        </span>
      </span>
      <style>{`@keyframes gooniBlink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }`}</style>
    </div>
  );
}
