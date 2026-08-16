import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SurfacePanel } from "./SurfacePanel";

/**
 * The one invariant behind five regressions (#488, #493, #498, #500, #507):
 * WHICH ELEMENT CARRIES THE TRANSFORM.
 *
 * On the panel (`position: absolute` inside the clip) the transform stopped
 * taking effect in the exact commit the surface's own subtree mounted — the
 * computed matrix animated the full width while the border box and the painted
 * pixels both stayed put. It reproduced for notes and never for the lighter
 * surfaces, which is why it kept reading as "notes is special". On the clip box
 * (`position: fixed`) it works, and the panel rides along.
 *
 * jsdom has no `Element.animate`, so the component takes its no-motion branch
 * and writes the end state straight to the style — which is exactly what makes
 * the *target* assertable here even though the motion itself is not.
 */
function clipOf(container: HTMLElement) {
  return container.querySelector("[data-surface-clip]") as HTMLElement;
}
function panelOf(container: HTMLElement) {
  return container.querySelector("[data-surface-panel]") as HTMLElement;
}

describe("SurfacePanel", () => {
  it("parks the CLIP off the right edge when closed, and never transforms the panel", () => {
    const { container } = render(
      <SurfacePanel open={false} viewKey="home" onDismiss={() => {}}>
        <div>surface</div>
      </SurfacePanel>,
    );
    expect(clipOf(container).style.transform).toBe("translateX(100%)");
    // The panel must stay untransformed — if a future pass moves the slide back
    // onto it, this is the line that fails.
    expect(panelOf(container).style.transform).toBe("");
  });

  it("slides the CLIP in on open and back out on close", () => {
    const { container, rerender } = render(
      <SurfacePanel open={false} viewKey="home" onDismiss={() => {}}>
        <div>surface</div>
      </SurfacePanel>,
    );

    rerender(
      <SurfacePanel open viewKey="notes" onDismiss={() => {}}>
        <div>surface</div>
      </SurfacePanel>,
    );
    expect(clipOf(container).style.transform).toBe("translateX(0)");
    expect(panelOf(container).style.transform).toBe("");

    rerender(
      <SurfacePanel open={false} viewKey="home" onDismiss={() => {}}>
        <div>surface</div>
      </SurfacePanel>,
    );
    // Back out to the right, UNCOVERING the always-mounted home beneath.
    expect(clipOf(container).style.transform).toBe("translateX(100%)");
  });

  it("a COLD LOAD straight onto a surface lands open with no slide", () => {
    const { container } = render(
      <SurfacePanel open viewKey="notes" onDismiss={() => {}}>
        <div>surface</div>
      </SurfacePanel>,
    );
    // Arriving at a URL is not a navigation within the app; the first paint is
    // already the end state rather than a frame parked off-screen.
    expect(clipOf(container).style.transform).toBe("translateX(0)");
  });

  it("replays the entrance when one surface is swapped for another", () => {
    const { container, rerender } = render(
      <SurfacePanel open={false} viewKey="home" onDismiss={() => {}}>
        <div>surface</div>
      </SurfacePanel>,
    );
    rerender(
      <SurfacePanel open viewKey="notes" onDismiss={() => {}}>
        <div>surface</div>
      </SurfacePanel>,
    );
    // notes -> memories never flips `open`, so only the viewKey can drive it.
    rerender(
      <SurfacePanel open viewKey="memories" onDismiss={() => {}}>
        <div>surface</div>
      </SurfacePanel>,
    );
    expect(clipOf(container).style.transform).toBe("translateX(0)");
  });
});
