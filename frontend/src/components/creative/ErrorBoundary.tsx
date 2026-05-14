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

  componentDidCatch() {
    // Swallow — fallback handles the user-visible state.
  }

  render() {
    return this.state.errored ? this.props.fallback : this.props.children;
  }
}
