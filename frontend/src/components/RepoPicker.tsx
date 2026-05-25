import { useEffect, useState } from "react";
import { listGithubRepos, trackRepo, untrackRepo, type GithubRepo } from "../services/api";
import { color as ctok } from "../ui";

const btn: React.CSSProperties = {
  fontSize: 11, padding: "3px 8px", borderRadius: 6,
  border: "1px solid rgba(0,0,0,0.1)", background: "var(--gooni-card, #fff)",
  cursor: "pointer", color: ctok.text, fontWeight: 500,
  fontFamily: "'Inter', -apple-system, sans-serif",
};

export function RepoPicker() {
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      setRepos(await listGithubRepos());
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function toggle(repo: GithubRepo) {
    const key = `${repo.owner}/${repo.name}`;
    setPendingKey(key);
    try {
      if (repo.tracked) await untrackRepo(repo.owner, repo.name);
      else await trackRepo(repo.owner, repo.name);
      setRepos((prev) =>
        prev?.map((r) =>
          r.owner === repo.owner && r.name === repo.name ? { ...r, tracked: !r.tracked } : r,
        ) ?? null,
      );
      // Tell the dashboard to refetch on next view.
      window.dispatchEvent(new CustomEvent("gooni-tracked-repos-changed"));
    } catch (e) {
      setErr(String(e));
    } finally {
      setPendingKey(null);
    }
  }

  const filtered = (repos ?? []).filter((r) =>
    !filter ? true : r.full_name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter repos…"
          style={{
            flex: 1, fontSize: 11.5, padding: "4px 8px", borderRadius: 6,
            border: "1px solid rgba(0,0,0,0.1)", background: "var(--gooni-card, #fff)",
            fontFamily: "'Inter', -apple-system, sans-serif",
          }}
        />
        <button onClick={refresh} disabled={loading} style={btn}>
          {loading ? "…" : "refresh"}
        </button>
      </div>
      {err && <div style={{ fontSize: 11, color: "#C44", marginBottom: 6 }}>{err}</div>}
      <div style={{
        // Caps at ~4 visible rows (each ~30px tall). Keeps the integrations
        // panel compact instead of letting one repo list dominate the modal.
        maxHeight: 132, overflowY: "auto",
        border: "1px solid rgba(0,0,0,0.06)", borderRadius: 8,
        background: "var(--gooni-card, #fff)",
      }}>
        {repos === null && loading ? (
          <div style={{ padding: 10, fontSize: 11.5, color: ctok.muted }}>loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 10, fontSize: 11.5, color: ctok.muted }}>no repos</div>
        ) : (
          filtered.map((r) => {
            const key = `${r.owner}/${r.name}`;
            const pending = pendingKey === key;
            return (
              <label
                key={key}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "4px 10px",
                  borderBottom: "1px solid rgba(0,0,0,0.04)",
                  cursor: pending ? "wait" : "pointer",
                  opacity: pending ? 0.6 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={r.tracked}
                  disabled={pending}
                  onChange={() => toggle(r)}
                />
                <span style={{ fontSize: 12, color: ctok.text, fontWeight: 500 }}>
                  {r.full_name}
                </span>
                {r.private && (
                  <span style={{
                    fontSize: 9.5, color: ctok.muted,
                    border: "1px solid rgba(0,0,0,0.1)", borderRadius: 3,
                    padding: "0 4px", letterSpacing: 0.3,
                  }}>private</span>
                )}
                {r.description && (
                  <span style={{
                    fontSize: 11, color: ctok.muted,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    flex: 1,
                  }}>
                    — {r.description}
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
