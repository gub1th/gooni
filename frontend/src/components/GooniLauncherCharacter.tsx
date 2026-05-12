import { useEffect, useRef } from "react";

// Inline-SVG Gooni mascot used inside the floating chat-launcher buttons
// (both the authed-app ChatLauncher and the public PublicChatLauncher).
// Eyes track the cursor when visible; the whole character fades when the
// drag flow has handed off the character to GooniMascot.
//
// Replaces the older AuraOrb (morphing-halo abstract orb) so the launcher
// matches the rest of the Gooni mascot system.

interface GooniLauncherCharacterProps {
  size: number;
  characterHidden: boolean;
}

export function GooniLauncherCharacter({ size, characterHidden }: GooniLauncherCharacterProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const eyeLeftRef = useRef<SVGCircleElement>(null);
  const eyeRightRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (characterHidden) return;
      const el = svgRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const MAX = 2.5;
      const t = Math.min(1, dist / 240);
      const transform = `translate(${((dx / dist) * MAX * t).toFixed(2)} ${((dy / dist) * MAX * t).toFixed(2)})`;
      eyeLeftRef.current?.setAttribute("transform", transform);
      eyeRightRef.current?.setAttribute("transform", transform);
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [characterHidden]);

  useEffect(() => {
    if (!characterHidden) return;
    eyeLeftRef.current?.setAttribute("transform", "translate(0 0)");
    eyeRightRef.current?.setAttribute("transform", "translate(0 0)");
  }, [characterHidden]);

  return (
    <svg
      ref={svgRef}
      width={size + 16}
      height={size + 16}
      viewBox="0 0 90 100"
      style={{
        position: "absolute",
        bottom: -8,
        left: -8,
        pointerEvents: "none",
        transition: "opacity 0.2s ease, transform 0.2s ease",
        opacity: characterHidden ? 0 : 1,
        transform: characterHidden ? "translateY(8px)" : "translateY(0)",
      }}
    >
      <rect x="29" y="50" width="32" height="38" rx="6" fill="#4ADE80" />
      <rect x="6" y="54" width="24" height="7" rx="3.5" fill="#1A1A1A" />
      <rect x="60" y="54" width="24" height="7" rx="3.5" fill="#1A1A1A" />
      <circle cx="45" cy="32" r="22" fill="#1A1A1A" />
      <circle cx="45" cy="32" r="17" fill="#F2F2F2" />
      <circle ref={eyeLeftRef} cx="38" cy="30" r="3" fill="#1A1A1A" />
      <circle ref={eyeRightRef} cx="52" cy="30" r="3" fill="#1A1A1A" />
      <path d="M38 39 Q45 45 52 40" stroke="#1A1A1A" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}
