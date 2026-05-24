import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { color as ctok, FONT } from "../ui";
import { publicMcpConfigQueryOptions } from "../utils/publicQueries";

const MONO = "'SF Mono', 'Menlo', 'Monaco', ui-monospace, monospace";

export const Route = createFileRoute("/public/mcp")({
  component: MCPPage,
});

function MCPPage() {
  const { data, error } = useQuery(publicMcpConfigQueryOptions());
  const err = error ? String(error) : null;

  return (
    <div style={{ minHeight: "100vh", background: "#fff", fontFamily: FONT, color: "#111" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "60px 24px 120px" }}>
        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 10 }}>
            Gooni's MCP setup
          </div>
          <p style={{ fontSize: 14, color: "#6B6B70", lineHeight: 1.65, margin: 0, maxWidth: 620 }}>
            The Model Context Protocol servers I've wired into my Claude Code — how Claude
            reaches into Gooni to read notes, manage memories, and hit todos. Auto-generated
            from my local <code style={{ fontFamily: MONO, fontSize: 13, color: "#444" }}>.mcp.json</code>{" "}
            and the MCP server source. Updates as I add tools.
          </p>
        </div>

        {err && (
          <p style={{ color: "#c44", fontSize: 14 }}>Couldn't load MCP config: {err}</p>
        )}

        {/* Servers */}
        {data?.servers && data.servers.length > 0 && (
          <section style={{ marginBottom: 48 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: ctok.muted,
              letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 12,
            }}>
              Servers
            </div>
            {data.servers.map((s) => (
              <div
                key={s.name}
                style={{
                  border: "1px solid rgba(0,0,0,0.08)",
                  borderRadius: 12,
                  padding: "14px 18px",
                  marginBottom: 10,
                  background: "#FDFCFA",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
                  <div style={{ fontSize: 15.5, fontWeight: 600, color: "#111" }}>{s.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: "#888" }}>
                    {s.command}{s.script ? ` ${s.script}` : ""}
                  </div>
                </div>
                {s.env_keys.length > 0 && (
                  <div style={{ fontSize: 12, color: ctok.muted, marginTop: 4 }}>
                    env:&nbsp;
                    {s.env_keys.map((k, i) => (
                      <span key={k}>
                        <code style={{ fontFamily: MONO, color: "#555" }}>{k}</code>
                        {i < s.env_keys.length - 1 ? ", " : ""}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {/* Tools */}
        {data?.tools && data.tools.length > 0 && (
          <section>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: ctok.muted,
                letterSpacing: 0.6, textTransform: "uppercase",
              }}>
                Tools
              </div>
              <div style={{ fontSize: 11, color: ctok.faint }}>{data.tools.length} exposed</div>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {data.tools.map((t) => (
                <li
                  key={t.name}
                  style={{
                    padding: "14px 0",
                    borderBottom: "1px solid rgba(0,0,0,0.06)",
                  }}
                >
                  <div style={{ fontFamily: MONO, fontSize: 13, color: "#111", marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{t.name}</span>
                    <span style={{ color: "#888" }}>(</span>
                    {t.params.map((p, i) => (
                      <span key={p.name}>
                        <span style={{ color: p.required ? "#111" : "#999" }}>{p.name}</span>
                        {!p.required && <span style={{ color: "#ccc" }}>?</span>}
                        {i < t.params.length - 1 && <span style={{ color: "#aaa" }}>, </span>}
                      </span>
                    ))}
                    <span style={{ color: "#888" }}>)</span>
                  </div>
                  {t.description && (
                    <div style={{ fontSize: 13.5, color: "#555", lineHeight: 1.6 }}>
                      {t.description}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Footer note */}
        <div style={{
          marginTop: 48, paddingTop: 18, borderTop: "1px solid rgba(0,0,0,0.06)",
          fontSize: 12, color: ctok.faint, lineHeight: 1.6,
        }}>
          MCP (Model Context Protocol) lets Claude invoke local tools your account controls.
          This list is scraped from my active config at request time —
          not a curated list, just whatever is wired up right now.
        </div>
      </div>
    </div>
  );
}
