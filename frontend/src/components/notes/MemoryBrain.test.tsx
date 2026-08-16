/**
 * The memory graph's GROUPING rule — what decides a node's colour and where it
 * sits. Pure (`buildGroups` takes memories + the initiative snapshot + a box
 * and returns anchors), so this asserts the rule without standing up a canvas.
 *
 * The three things worth pinning, each a way the graph could quietly lie:
 *   · Initiative is the PRIMARY grouping — and type grouping is a live
 *     FALLBACK, not dead code: before the first synthesis (and on a failed
 *     fetch) the snapshot is legitimately empty, and one undifferentiated blob
 *     is worse than the graph this replaced.
 *   · Every memory lands in exactly one group. A row the synthesizer never saw
 *     (written since the last refresh) is UNCATEGORIZED, never dropped and
 *     never silently folded into the nearest cluster.
 *   · Uncategorized gets its own band, not a peer slot on the ring — "belongs
 *     to nothing" is a different kind of answer from "belongs to this one".
 */

import { describe, expect, it } from "vitest";

import { buildGroups, stageHeightFor } from "./MemoryBrain";
import type { ApiInitiatives, ApiMemory } from "../../services/api";

const W = 900;
const H = 600;

function mem(id: number, type: string): ApiMemory {
  return {
    id,
    type: type as ApiMemory["type"],
    key: null,
    content: `memory ${id}`,
    confidence: 0.8,
    is_active: true,
    superseded_by: null,
    focus_id: null,
    retrieval_count: 0,
    last_retrieved_at: null,
    created_at: null,
    updated_at: null,
    source_note_id: null,
    source_message_id: null,
    source: null,
  };
}

function snapshot(
  clusters: { label: string; memoryIds: number[]; extra?: number }[],
): ApiInitiatives {
  return {
    built_at: "2026-08-16T09:00:00+00:00",
    item_count: 99,
    clusters: clusters.map((c) => ({
      label: c.label,
      size: c.memoryIds.length + (c.extra ?? 0),
      summary: "a · b",
      by_type: {},
      items: [
        ...c.memoryIds.map((id) => ({ type: "memory" as const, id, text: `memory ${id}` })),
        // Initiatives span three primitives; the non-memory members must not
        // become phantom nodes on a canvas that only draws memories.
        ...Array.from({ length: c.extra ?? 0 }, (_, i) => ({
          type: "promise" as const, id: 900 + i, text: "a promise",
        })),
      ],
    })),
    uncategorized: { count: 0, items: [] },
    total_clusters: clusters.length,
    truncated: false,
  };
}

describe("buildGroups", () => {
  const memories = [mem(1, "fact"), mem(2, "fact"), mem(3, "episode"), mem(4, "routine")];

  it("groups by INITIATIVE when a snapshot is available", () => {
    const g = buildGroups(
      memories,
      snapshot([
        { label: "Interview prep", memoryIds: [1, 2] },
        { label: "Gooni development", memoryIds: [3, 4] },
      ]),
      W,
      H,
    );
    expect(g.mode).toBe("initiative");
    expect(g.groups.map((x) => x.label)).toEqual(["Interview prep", "Gooni development"]);
    // Same initiative → same group, regardless of memory type.
    expect(g.memberOf.get(1)).toBe(g.memberOf.get(2));
    expect(g.memberOf.get(3)).toBe(g.memberOf.get(4));
    expect(g.memberOf.get(1)).not.toBe(g.memberOf.get(3));
    // …and type no longer decides anything: 1 (fact) and 3 (episode) are
    // grouped apart while 3 (episode) and 4 (routine) are grouped together.
    expect(g.memberOf.get(3)).toBe(g.memberOf.get(4));
  });

  it("gives each initiative a distinct colour", () => {
    const g = buildGroups(
      memories,
      snapshot([
        { label: "A", memoryIds: [1, 2] },
        { label: "B", memoryIds: [3] },
        { label: "C", memoryIds: [4] },
      ]),
      W,
      H,
    );
    const colors = g.groups.filter((x) => !x.dim).map((x) => x.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("falls back to TYPE grouping when nothing has been synthesized", () => {
    for (const snap of [null, snapshot([])]) {
      const g = buildGroups(memories, snap, W, H);
      expect(g.mode).toBe("type");
      expect(g.groups.map((x) => x.label).sort()).toEqual(["episode", "fact", "routine"]);
      expect(g.memberOf.get(1)).toBe(g.memberOf.get(2)); // both facts
      expect(g.memberOf.get(3)).not.toBe(g.memberOf.get(4));
      // The fallback has no uncategorized band — every memory has a type.
      expect(g.groups.some((x) => x.dim)).toBe(false);
    }
  });

  it("puts a memory the synthesizer never saw in UNCATEGORIZED, not nowhere", () => {
    const g = buildGroups(
      memories,
      snapshot([{ label: "Interview prep", memoryIds: [1, 2] }]),
      W,
      H,
    );
    const dim = g.groups.find((x) => x.dim);
    expect(dim).toBeTruthy();
    expect(dim!.count).toBe(2); // 3 and 4 were in no cluster
    // Not assigned to a named group, and not lost either — the renderer sends
    // anything without a membership to the dim band.
    expect(g.memberOf.has(3)).toBe(false);
    expect(g.memberOf.has(4)).toBe(false);
    const named = g.groups.filter((x) => !x.dim);
    expect(named.reduce((n, x) => n + x.count, 0) + dim!.count).toBe(memories.length);
  });

  it("counts only the MEMORY members of an initiative as nodes", () => {
    const g = buildGroups(
      [mem(1, "fact"), mem(2, "fact")],
      snapshot([{ label: "Interview prep", memoryIds: [1, 2], extra: 5 }]),
      W,
      H,
    );
    // The cluster's `size` is 7 (2 memories + 5 promises); only 2 are drawable
    // here, and the group's count must describe what is on the canvas.
    expect(g.groups[0].count).toBe(2);
  });

  it("drops an initiative with no memories on this canvas rather than leaving a gap", () => {
    const g = buildGroups(
      [mem(1, "fact"), mem(2, "fact")],
      snapshot([
        { label: "Interview prep", memoryIds: [1, 2] },
        { label: "All promises", memoryIds: [], extra: 4 },
      ]),
      W,
      H,
    );
    expect(g.groups.filter((x) => !x.dim).map((x) => x.label)).toEqual(["Interview prep"]);
  });

  it("reserves a band for uncategorized and none when there is none", () => {
    const withNoise = buildGroups(
      memories,
      snapshot([{ label: "Interview prep", memoryIds: [1, 2] }]),
      W,
      H,
    );
    const noNoise = buildGroups(
      memories,
      snapshot([
        { label: "Interview prep", memoryIds: [1, 2] },
        { label: "Gooni development", memoryIds: [3, 4] },
      ]),
      W,
      H,
    );
    expect(stageHeightFor(memories, withNoise, H)).toBeLessThan(H);
    expect(stageHeightFor(memories, noNoise, H)).toBe(H);

    // The band sits BELOW the ring, so nothing in it overlaps a named cluster.
    const stage = stageHeightFor(memories, withNoise, H);
    const dim = withNoise.groups.find((x) => x.dim)!;
    expect(dim.anchorY).toBeGreaterThan(stage);
    for (const g of withNoise.groups.filter((x) => !x.dim)) {
      expect(g.anchorY).toBeLessThan(stage);
    }
  });

  it("anchors every group inside the box", () => {
    const g = buildGroups(
      memories,
      snapshot([
        { label: "A", memoryIds: [1] },
        { label: "B", memoryIds: [2] },
        { label: "C", memoryIds: [3] },
      ]),
      W,
      H,
    );
    for (const grp of g.groups) {
      expect(grp.anchorX).toBeGreaterThan(0);
      expect(grp.anchorX).toBeLessThan(W);
      expect(grp.anchorY).toBeGreaterThan(0);
      expect(grp.anchorY).toBeLessThan(H);
    }
  });

  it("is stable — the same inputs give the same groups and colours", () => {
    const snap = snapshot([
      { label: "A", memoryIds: [1, 2] },
      { label: "B", memoryIds: [3] },
    ]);
    const a = buildGroups(memories, snap, W, H);
    const b = buildGroups(memories, snap, W, H);
    expect(a.groups.map((g) => [g.key, g.label, g.color, g.anchorX, g.anchorY]))
      .toEqual(b.groups.map((g) => [g.key, g.label, g.color, g.anchorX, g.anchorY]));
  });

  it("handles an empty canvas without inventing a group", () => {
    const g = buildGroups([], snapshot([{ label: "A", memoryIds: [1] }]), W, H);
    expect(g.groups).toEqual([]);
  });
});
