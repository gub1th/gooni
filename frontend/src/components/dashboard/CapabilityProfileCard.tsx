import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { color as ctok, FONT } from "../../ui";
import {
  fetchCapabilityFacets,
  patchCapabilityFacet,
  refreshCapabilityTelemetry,
  type ApiCapabilityFacet,
} from "../../services/api";


// Visible-to-Daniel layers, in render order. Mechanical is implicit in the
// tool schemas the LLM already sees, so the card foregrounds the layers Daniel
// actually curates (functional/behavioral/architectural) and folds mechanical
// behind a count + drawer.
const LAYER_ORDER = ["functional", "behavioral", "architectural", "mechanical"] as const;

const LAYER_LABEL: Record<string, string> = {
  functional: "What I can do",
  behavioral: "How I tend to act",
  architectural: "What I am",
  mechanical: "Tools / routes / channels",
};

const STATUS_COLOR: Record<string, string> = {
  verified: "#34C759",
  claimed: ctok.accent,
  unverified: ctok.muted,
  broken: ctok.danger,
  removed: "#C7C7CC",
};

export function CapabilityProfileCard() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["capabilities"],
    queryFn: fetchCapabilityFacets,
    staleTime: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div style={cardStyle}>
        <div style={titleStyle}>Who I am right now</div>
        <div style={{ color: ctok.muted, fontSize: 12, marginTop: 8 }}>Loading…</div>
      </div>
    );
  }

  const byLayer = data.by_layer || {};
  const total = data.total;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={titleStyle}>Who I am right now</div>
        <button onClick={() => setDrawerOpen(true)} style={openBtnStyle}>
          {total} facets ›
        </button>
      </div>

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {(["functional", "behavioral", "architectural"] as const).map((L) => {
          const rows = (byLayer[L] || []).filter((r) => r.status !== "removed").slice(0, 3);
          if (rows.length === 0) return null;
          return (
            <div key={L}>
              <div style={miniLabelStyle}>{LAYER_LABEL[L]}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {rows.map((r) => (
                  <FacetLine key={r.id} facet={r} />
                ))}
              </div>
            </div>
          );
        })}
        {!Object.keys(byLayer).some((L) =>
          ["functional", "behavioral", "architectural"].includes(L),
        ) && (
          <div style={{ color: ctok.muted, fontSize: 12 }}>
            No functional/behavioral/architectural facets yet — boot scan only populates
            mechanical. Seed via the <code>/capabilities</code> POST route, the
            <code>/capability-audit</code> Claude Code skill, or the
            <code>update_capability_facet</code> chat tool.
          </div>
        )}
      </div>

      {drawerOpen && (
        <CapabilityDrawer
          byLayer={byLayer}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}

function FacetLine({ facet }: { facet: ApiCapabilityFacet }) {
  const dot = STATUS_COLOR[facet.status] || ctok.muted;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12.5 }}>
      <span style={{ color: dot, marginTop: 5, fontSize: 8 }}>●</span>
      <span style={{ color: ctok.text, lineHeight: 1.45 }}>{facet.facet_text}</span>
    </div>
  );
}

function CapabilityDrawer({
  byLayer,
  onClose,
}: {
  byLayer: Record<string, ApiCapabilityFacet[]>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  async function refreshTelemetry() {
    setRefreshing(true);
    try {
      await refreshCapabilityTelemetry();
      await qc.invalidateQueries({ queryKey: ["capabilities"] });
    } finally {
      setRefreshing(false);
    }
  }

  async function patchStatus(facet: ApiCapabilityFacet, status: string) {
    await patchCapabilityFacet(facet.id, { status });
    await qc.invalidateQueries({ queryKey: ["capabilities"] });
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        zIndex: 100, display: "flex", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480, maxWidth: "92vw", height: "100vh",
          background: "#FFFFFF", overflowY: "auto",
          padding: "20px 24px", boxShadow: "-8px 0 24px rgba(0,0,0,0.15)",
          fontFamily: FONT,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Capability inventory</div>
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close">×</button>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: "#636366" }}>
          Boot scan populates mechanical layer from the tool registry + FastAPI
          routes + messaging channels. Behavioral facets are auto-promoted from
          per-turn reflection clusters. Edit status to override.
        </div>
        <button
          onClick={refreshTelemetry}
          disabled={refreshing}
          style={refreshBtnStyle(refreshing)}
        >
          {refreshing ? "Refreshing…" : "Run telemetry rollup now"}
        </button>

        {LAYER_ORDER.map((L) => {
          const rows = byLayer[L] || [];
          if (rows.length === 0) return null;
          return (
            <div key={L} style={{ marginTop: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: ctok.text, marginBottom: 6 }}>
                {LAYER_LABEL[L]} ({rows.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {rows.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      border: "1px solid rgba(0,0,0,0.08)", borderRadius: 8,
                      padding: "8px 10px", background: r.status === "removed" ? "#FAFAFA" : "#FFFFFF",
                      opacity: r.status === "removed" ? 0.55 : 1,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: ctok.muted }}>
                      <span
                        style={{
                          background: STATUS_COLOR[r.status] || ctok.muted,
                          color: "#FFF", padding: "1px 6px", borderRadius: 4,
                          fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                        }}
                      >
                        {r.status}
                      </span>
                      <code style={{ fontSize: 11 }}>{r.facet_key}</code>
                      <span style={{ marginLeft: "auto" }}>{r.source}</span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 13, color: ctok.text }}>
                      {r.facet_text}
                    </div>
                    <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {(["verified", "claimed", "unverified", "broken"] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => patchStatus(r, s)}
                          disabled={r.status === s}
                          style={pillBtnStyle(r.status === s, STATUS_COLOR[s])}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#FFFFFF",
  border: "1px solid rgba(0,0,0,0.08)",
  borderRadius: 12,
  padding: "14px 16px",
  marginTop: 14,
  fontFamily: FONT,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14, fontWeight: 600, color: ctok.text,
};

const miniLabelStyle: React.CSSProperties = {
  fontSize: 11, color: ctok.muted, textTransform: "uppercase",
  fontWeight: 600, letterSpacing: 0.3, marginBottom: 4,
};

const openBtnStyle: React.CSSProperties = {
  background: "transparent", border: "none", color: ctok.accent,
  fontSize: 12, cursor: "pointer", padding: 0,
};

const closeBtnStyle: React.CSSProperties = {
  background: "transparent", border: "none", fontSize: 24, lineHeight: 1,
  cursor: "pointer", color: ctok.muted, padding: "0 6px",
};

const refreshBtnStyle = (disabled: boolean): React.CSSProperties => ({
  marginTop: 12,
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(0,0,0,0.1)",
  background: disabled ? "#F2F2F7" : "#FFFFFF",
  color: ctok.text,
  fontSize: 12,
  cursor: disabled ? "default" : "pointer",
  fontFamily: FONT,
});

const pillBtnStyle = (active: boolean, color: string): React.CSSProperties => ({
  padding: "2px 8px",
  borderRadius: 10,
  border: `1px solid ${active ? color : "rgba(0,0,0,0.12)"}`,
  background: active ? color : "transparent",
  color: active ? "#FFF" : "#636366",
  fontSize: 10,
  textTransform: "uppercase",
  fontWeight: 600,
  cursor: active ? "default" : "pointer",
  fontFamily: FONT,
});
