import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNowTick } from "./useNowTick";
import { freshness, STALE_MS } from "../components/ambient/whoopFreshness";

afterEach(() => {
  vi.useRealTimers();
});

describe("useNowTick", () => {
  it("advances the clock without a remount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 14, 12, 0, 0));
    const { result } = renderHook(() => useNowTick(30_000));
    const first = result.current;

    act(() => { vi.advanceTimersByTime(90_000); });

    expect(result.current - first).toBe(90_000);
  });

  it("lets a mounted reading cross the stale threshold on its own", () => {
    // The regression: age was read from Date.now() once per render, so a whoop
    // tile left open could never flip to stale while being watched.
    vi.useFakeTimers();
    const mountedAt = Date.UTC(2026, 6, 14, 12, 0, 0);
    vi.setSystemTime(mountedAt);
    const stamp = new Date(mountedAt - STALE_MS + 60_000).toISOString(); // 35h old
    const { result } = renderHook(() => useNowTick(30_000));

    expect(freshness(stamp, result.current)).toMatchObject({ stale: false, label: "35h ago" });

    act(() => { vi.advanceTimersByTime(2 * 60_000); });

    expect(freshness(stamp, result.current)).toMatchObject({ stale: true, label: "36h ago" });
  });

  it("stops ticking once unmounted", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { result, unmount } = renderHook(() => useNowTick(30_000));
    const last = result.current;
    unmount();

    act(() => { vi.advanceTimersByTime(10 * 60_000); });

    expect(clearSpy).toHaveBeenCalled();
    expect(result.current).toBe(last);
    clearSpy.mockRestore();
  });
});
