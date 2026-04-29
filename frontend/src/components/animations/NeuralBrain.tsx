interface NeuralBrainProps {
  size?: number;
  onClick?: () => void;
}

const KEYFRAMES = `
  @keyframes brainLiftBob {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    50% { transform: translateY(-3px) rotate(3deg); }
  }
  @keyframes nodePulse {
    0%, 100% { opacity: 0.7; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.2); }
  }
  @keyframes brainMgLift {
    0%, 100% { transform: rotate(-8deg); }
    50% { transform: rotate(-4deg); }
  }

  .brain-lift-wrap {
    position: relative;
    width: 64px;
    height: 72px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .brain-lift-svg { animation: brainLiftBob 2.5s ease-in-out infinite; }
  .brain-node-pulse { animation: nodePulse 2s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
  .brain-node-pulse:nth-child(odd) { animation-delay: 0.5s; }

  .brain-mini-gooni { position: relative; width: 20px; margin-top: -2px; }
  .brain-mg-arms-up { display: flex; gap: 8px; justify-content: center; margin-bottom: -3px; }
  .brain-mg-arm {
    width: 3px; height: 10px; border-radius: 1.5px; background: #1a1a1a;
    animation: brainMgLift 2.5s ease-in-out infinite;
  }
  .brain-mg-arm:nth-child(1) { transform: rotate(-8deg); transform-origin: bottom; }
  .brain-mg-arm:nth-child(2) { transform: rotate(8deg); transform-origin: bottom; animation-delay: 0.1s; }
  .brain-mg-head {
    width: 16px; height: 16px; border-radius: 50%; background: #1a1a1a;
    display: flex; align-items: center; justify-content: center; margin: 0 auto;
  }
  .brain-mg-face { width: 11px; height: 11px; border-radius: 50%; background: #f2f2f2; position: relative; }
  .brain-mg-eye { width: 2px; height: 2px; border-radius: 50%; background: #1a1a1a; position: absolute; top: 4px; }
  .brain-mg-eye.l { left: 2px; }
  .brain-mg-eye.r { right: 2px; }
  .brain-mg-mouth {
    width: 4px; border-bottom: 1px solid #1a1a1a;
    position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%);
  }
  .brain-mg-torso { width: 10px; height: 8px; background: #4ADE80; border-radius: 2px; margin: -1px auto 0; }
  .brain-mg-legs { display: flex; gap: 2px; justify-content: center; margin-top: -1px; }
  .brain-mg-leg { width: 3px; height: 7px; border-radius: 1.5px; background: #1a1a1a; }
`;

export function NeuralBrain({ size = 64, onClick }: NeuralBrainProps) {
  const scale = size / 64;
  const wrapW = 64 * scale;
  const wrapH = 72 * scale;

  return (
    <button
      onClick={onClick}
      title="Visualize notes"
      aria-label="Visualize notes"
      style={{
        background: "#fff",
        border: "0.5px solid rgba(0,0,0,0.08)",
        borderRadius: 10,
        padding: 6,
        cursor: onClick ? "pointer" : "default",
        transition: "transform 0.15s, border-color 0.15s, box-shadow 0.15s",
        width: wrapW + 12,
        height: wrapH + 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.style.transform = "scale(1.04)";
        b.style.borderColor = "rgba(0,0,0,0.15)";
        b.style.boxShadow = "0 2px 10px rgba(74,222,128,0.18)";
      }}
      onMouseLeave={(e) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.style.transform = "scale(1)";
        b.style.borderColor = "rgba(0,0,0,0.08)";
        b.style.boxShadow = "none";
      }}
    >
      <style>{KEYFRAMES}</style>
      <div className="brain-lift-wrap" style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>
        <svg className="brain-lift-svg" width="44" height="36" viewBox="0 0 44 36">
          <path
            d="M22 2C14 2 8 7 8 14C4 14 2 18 2 22C2 26 5 30 10 30C10 33 14 35 18 35C20 35 22 34 22 34C22 34 24 35 26 35C30 35 34 33 34 30C39 30 42 26 42 22C42 18 40 14 36 14C36 7 30 2 22 2Z"
            fill="#1a1a1a"
            opacity="0.08"
          />
          <path
            d="M22 2C14 2 8 7 8 14C4 14 2 18 2 22C2 26 5 30 10 30C10 33 14 35 18 35C20 35 22 34 22 34C22 34 24 35 26 35C30 35 34 33 34 30C39 30 42 26 42 22C42 18 40 14 36 14C36 7 30 2 22 2Z"
            fill="none"
            stroke="#1a1a1a"
            strokeWidth="1.5"
          />
          <line x1="14" y1="12" x2="22" y2="18" stroke="#4ADE80" strokeWidth="0.8" opacity="0.6" />
          <line x1="30" y1="12" x2="22" y2="18" stroke="#4ADE80" strokeWidth="0.8" opacity="0.6" />
          <line x1="22" y1="18" x2="16" y2="26" stroke="#4ADE80" strokeWidth="0.8" opacity="0.6" />
          <line x1="22" y1="18" x2="28" y2="26" stroke="#4ADE80" strokeWidth="0.8" opacity="0.6" />
          <line x1="14" y1="12" x2="10" y2="20" stroke="#4ADE80" strokeWidth="0.8" opacity="0.4" />
          <line x1="30" y1="12" x2="34" y2="20" stroke="#4ADE80" strokeWidth="0.8" opacity="0.4" />
          <line x1="10" y1="20" x2="16" y2="26" stroke="#4ADE80" strokeWidth="0.8" opacity="0.4" />
          <line x1="34" y1="20" x2="28" y2="26" stroke="#4ADE80" strokeWidth="0.8" opacity="0.4" />
          <circle className="brain-node-pulse" cx="14" cy="12" r="3" fill="#4ADE80" />
          <circle className="brain-node-pulse" cx="30" cy="12" r="3" fill="#4ADE80" />
          <circle className="brain-node-pulse" cx="22" cy="18" r="3.5" fill="#4ADE80" />
          <circle className="brain-node-pulse" cx="10" cy="20" r="2.5" fill="#4ADE80" opacity="0.7" />
          <circle className="brain-node-pulse" cx="34" cy="20" r="2.5" fill="#4ADE80" opacity="0.7" />
          <circle className="brain-node-pulse" cx="16" cy="26" r="2.5" fill="#4ADE80" opacity="0.7" />
          <circle className="brain-node-pulse" cx="28" cy="26" r="2.5" fill="#4ADE80" opacity="0.7" />
        </svg>
        <div className="brain-mini-gooni">
          <div className="brain-mg-arms-up">
            <div className="brain-mg-arm" />
            <div className="brain-mg-arm" />
          </div>
          <div className="brain-mg-head">
            <div className="brain-mg-face">
              <div className="brain-mg-eye l" />
              <div className="brain-mg-eye r" />
              <div className="brain-mg-mouth" />
            </div>
          </div>
          <div className="brain-mg-torso" />
          <div className="brain-mg-legs">
            <div className="brain-mg-leg" />
            <div className="brain-mg-leg" />
          </div>
        </div>
      </div>
    </button>
  );
}
