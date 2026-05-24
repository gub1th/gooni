interface AuraOrbProps {
  size?: number;
  // When mascot is out of the FAB, intensify the aura so it reads as the
  // active drop target.
  intensified?: boolean;
}

const KEYFRAMES = `
  @keyframes auraMorph {
    0%, 100% { border-radius: 50% 40% 50% 40%; transform: rotate(0deg) scale(1); }
    25%      { border-radius: 40% 50% 40% 50%; transform: rotate(90deg) scale(1.05); }
    50%      { border-radius: 50% 40% 50% 40%; transform: rotate(180deg) scale(0.95); }
    75%      { border-radius: 40% 50% 40% 50%; transform: rotate(270deg) scale(1.02); }
  }
  @keyframes auraLook {
    0%, 45%, 55%, 100% { transform: translateX(0); }
    50% { transform: translateX(2px); }
  }
  @keyframes auraBlink {
    0%, 90%, 100% { transform: scaleY(1); }
    95%           { transform: scaleY(0.1); }
  }

  .aura-wrap {
    position: relative; width: 80px; height: 80px;
    display: flex; align-items: center; justify-content: center;
  }
  .aura-blob {
    position: absolute; border-radius: 50%;
    animation: auraMorph 4s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }
  .aura-blob-1 { width: 70px; height: 70px; top: 5px;  left: 5px;  background: #4ADE80; opacity: 0.12; }
  .aura-blob-2 {
    width: 56px; height: 56px; top: 12px; left: 12px; background: #4ADE80;
    opacity: 0.10; animation-direction: reverse; animation-duration: 3s;
  }
  .aura-blob-3 {
    width: 44px; height: 44px; top: 18px; left: 18px; background: #4ADE80;
    opacity: 0.08; animation-duration: 5s;
  }
  /* Intensified state — mascot is out, FAB is acting as drop target. Bump the
     blob opacities up so the orb glows brighter against the page. */
  .aura-wrap.aura-intensified .aura-blob-1 { opacity: 0.32; }
  .aura-wrap.aura-intensified .aura-blob-2 { opacity: 0.28; }
  .aura-wrap.aura-intensified .aura-blob-3 { opacity: 0.22; }

  .aura-head {
    width: 36px; height: 36px; border-radius: 50%; background: #1a1a1a;
    display: flex; align-items: center; justify-content: center;
    position: relative; z-index: 2;
  }
  .aura-face { width: 28px; height: 28px; border-radius: 50%; background: #f2f2f2; position: relative; }
  .aura-eye {
    width: 4px; height: 4px; border-radius: 50%; background: #1a1a1a;
    position: absolute; top: 10px; animation: auraLook 3s ease infinite;
  }
  .aura-eye.l { left: 6px; }
  .aura-eye.r { right: 6px; }
  .aura-blink { animation: auraBlink 3.5s ease-in-out infinite; }
  .aura-mouth {
    width: 8px; height: 3px; border-bottom: 1.5px solid #1a1a1a;
    border-radius: 0 0 4px 4px;
    position: absolute; bottom: 6px; left: 50%; transform: translateX(-50%);
  }
`;

export function AuraOrb({ size = 80, intensified = false }: AuraOrbProps) {
  const scale = size / 80;
  // The wrap stays at its class-defined 80×80 box so the absolutely-
  // positioned blobs (laid out for an 80px box, centered at 40,40) stay
  // centered on the face. We only scale visually — overriding width/height
  // to `size` shrank the box while the blobs kept 80px coords, pushing the
  // glow down-right of the face.
  return (
    <div
      className={`aura-wrap${intensified ? " aura-intensified" : ""}`}
      style={{
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: "center",
      }}
    >
      <style>{KEYFRAMES}</style>
      <div className="aura-blob aura-blob-1" />
      <div className="aura-blob aura-blob-2" />
      <div className="aura-blob aura-blob-3" />
      <div className="aura-head">
        <div className="aura-face">
          <div className="aura-eye aura-blink l" />
          <div className="aura-eye aura-blink r" />
          <div className="aura-mouth" />
        </div>
      </div>
    </div>
  );
}
