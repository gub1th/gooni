interface HamsterWheelProps {
  size?: number;
}

const KEYFRAMES = `
  @keyframes hamsterSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  @keyframes hamsterLean { 0%, 100% { transform: rotate(-8deg); } 50% { transform: rotate(-4deg); } }
  @keyframes hamsterBob  { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
  @keyframes hamsterPump { 0%, 100% { transform: rotate(-35deg); } 50% { transform: rotate(20deg); } }
  @keyframes hamsterRun  { 0%, 100% { transform: rotate(-30deg); } 50% { transform: rotate(30deg); } }

  .hamster-wrap { position: relative; width: 84px; height: 84px; }
  .hamster-svg {
    position: absolute; top: 0; left: 0; width: 84px; height: 84px;
    animation: hamsterSpin 2.2s cubic-bezier(0.3, 0, 0.2, 1) infinite;
    transform-origin: center;
  }
  .hamster-spoke { stroke: #ddd; stroke-width: 0.5; }

  .hamster-gooni {
    position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 3;
  }
  .hamster-body-wrap {
    transform: rotate(-8deg); transform-origin: bottom center;
    animation: hamsterLean 0.4s ease-in-out infinite;
  }
  .hamster-head {
    width: 22px; height: 22px; border-radius: 50%; background: #1a1a1a;
    display: flex; align-items: center; justify-content: center; margin: 0 auto;
    animation: hamsterBob 0.35s ease-in-out infinite;
  }
  .hamster-face { width: 16px; height: 16px; border-radius: 50%; background: #f2f2f2; position: relative; }
  .hamster-eye { width: 3px; height: 3px; border-radius: 50%; background: #1a1a1a; position: absolute; top: 5px; }
  .hamster-eye.l { left: 3px; }
  .hamster-eye.r { right: 3px; }
  .hamster-mouth {
    width: 5px; border-bottom: 1.5px solid #1a1a1a;
    position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
  }
  .hamster-torso { width: 14px; height: 11px; background: #4ADE80; border-radius: 3px; margin: -1px auto 0; }

  .hamster-arms { position: relative; width: 28px; height: 4px; margin: -8px auto 0; }
  .hamster-arm  { width: 11px; height: 3.5px; border-radius: 2px; background: #1a1a1a; position: absolute; }
  .hamster-arm.l { left: 0; transform-origin: right center; animation: hamsterPump 0.35s ease-in-out infinite; }
  .hamster-arm.r { right: 0; transform-origin: left center; animation: hamsterPump 0.35s ease-in-out infinite 0.175s; }

  .hamster-legs { display: flex; gap: 3px; justify-content: center; margin-top: -1px; }
  .hamster-leg  { width: 5px; height: 12px; border-radius: 2px; background: #1a1a1a; transform-origin: top center; }
  .hamster-leg.l { animation: hamsterRun 0.35s ease-in-out infinite; }
  .hamster-leg.r { animation: hamsterRun 0.35s ease-in-out infinite 0.175s; }
`;

export function HamsterWheel({ size = 84 }: HamsterWheelProps) {
  const scale = size / 84;
  return (
    <div
      className="hamster-wrap"
      style={{ width: size, height: size }}
    >
      <style>{KEYFRAMES}</style>
      <div style={{ position: "absolute", top: 0, left: 0, width: 84, height: 84, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <svg className="hamster-svg" viewBox="0 0 84 84">
          <circle cx="42" cy="42" r="38" fill="none" stroke="#ddd" strokeWidth="2" />
          <line x1="42" y1="4" x2="42" y2="14" className="hamster-spoke" />
          <line x1="42" y1="70" x2="42" y2="80" className="hamster-spoke" />
          <line x1="4" y1="42" x2="14" y2="42" className="hamster-spoke" />
          <line x1="70" y1="42" x2="80" y2="42" className="hamster-spoke" />
          <line x1="14" y1="14" x2="21" y2="21" className="hamster-spoke" />
          <line x1="63" y1="63" x2="70" y2="70" className="hamster-spoke" />
          <line x1="70" y1="14" x2="63" y2="21" className="hamster-spoke" />
          <line x1="14" y1="70" x2="21" y2="63" className="hamster-spoke" />
          <circle
            cx="42" cy="42" r="38"
            fill="none" stroke="#4ADE80" strokeWidth="2.5"
            strokeDasharray="70 169" strokeLinecap="round"
          />
        </svg>
        <div className="hamster-gooni">
          <div className="hamster-body-wrap">
            <div className="hamster-head">
              <div className="hamster-face">
                <div className="hamster-eye l" />
                <div className="hamster-eye r" />
                <div className="hamster-mouth" />
              </div>
            </div>
            <div className="hamster-torso" />
            <div className="hamster-arms">
              <div className="hamster-arm l" />
              <div className="hamster-arm r" />
            </div>
            <div className="hamster-legs">
              <div className="hamster-leg l" />
              <div className="hamster-leg r" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
