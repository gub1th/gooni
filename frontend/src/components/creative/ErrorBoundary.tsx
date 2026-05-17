import { Component, type ReactNode } from "react";

// Tiny error boundary used inside the R3F tree to catch GLTF/texture
// load failures and swap in a primitive fallback so a missing asset
// never crashes the whole scene.
export class ErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { errored: boolean }
> {
  state = { errored: false };

  static getDerivedStateFromError() {
    return { errored: true };
  }

  componentDidCatch(error: Error) {
    // Visible in console for debugging but doesn't bubble up — the
    // fallback handles the user-visible state. Most common cause: a
    // missing /models/*.glb asset.
    console.warn("[creative] asset boundary caught:", error.message);
  }

  render() {
    return this.state.errored ? this.props.fallback : this.props.children;
  }
}
