// /public/cv — the flat text portfolio. The "fast lane" out of the 3D
// plaza at /creative: everything a recruiter on a phone needs, in one
// column, no WebGL, no chrome.
//
// ALL copy comes from ../content/portfolio — this file owns layout and
// typography only. If a fact is missing here, add it there.
//
// /public/* renders bare (see isChromelessPath in __root.tsx), so this
// page owns its own palette. Theme handling is a scoped <style> block of
// CSS custom properties: prefers-color-scheme for the OS default, plus
// :root[data-theme="…"] overrides (higher specificity, so an explicit
// app-set theme always wins) — inline styles then read var(--cv-*).

import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FONT } from "../ui";
import {
  ARCHIVE,
  EDUCATION,
  MONUMENTS,
  PROFILE,
  PYLONS,
  ROLES,
  SKILLS,
  type Education,
  type Project,
  type Role,
} from "../content/portfolio";

export const Route = createFileRoute("/public/cv")({
  component: CvPage,
});

// Same display serif as the public index — system serifs only, no webfont
// network cost. Carries the name, section titles and stat figures.
const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";
// Metadata voice: periods, labels, stacks. Never body copy.
const MONO = "'SF Mono', 'Menlo', 'Monaco', ui-monospace, monospace";

const MAX_W = 720;

const isExternal = (href: string) => /^(https?:|mailto:)/i.test(href);

// ── palette + the handful of rules inline styles can't express ─────────
// (media queries, :hover, ::selection, prefers-reduced-motion)
const CSS = `
.cv {
  --cv-bg:        #FAF8F4;
  --cv-ink:       #15181B;
  --cv-body:      #3B4145;
  --cv-muted:     #6E757A;
  --cv-faint:     #9BA1A6;
  --cv-rule:      rgba(21,24,27,0.11);
  --cv-rule-firm: rgba(21,24,27,0.26);
  --cv-wash:      rgba(21,24,27,0.028);
}
@media (prefers-color-scheme: dark) {
  .cv {
    --cv-bg:        #0C0E0F;
    --cv-ink:       #F1EFEA;
    --cv-body:      #B6BBBE;
    --cv-muted:     #868C90;
    --cv-faint:     #626870;
    --cv-rule:      rgba(241,239,234,0.13);
    --cv-rule-firm: rgba(241,239,234,0.30);
    --cv-wash:      rgba(241,239,234,0.035);
  }
}
:root[data-theme="dark"] .cv {
  --cv-bg:        #0C0E0F;
  --cv-ink:       #F1EFEA;
  --cv-body:      #B6BBBE;
  --cv-muted:     #868C90;
  --cv-faint:     #626870;
  --cv-rule:      rgba(241,239,234,0.13);
  --cv-rule-firm: rgba(241,239,234,0.30);
  --cv-wash:      rgba(241,239,234,0.035);
}
:root[data-theme="light"] .cv {
  --cv-bg:        #FAF8F4;
  --cv-ink:       #15181B;
  --cv-body:      #3B4145;
  --cv-muted:     #6E757A;
  --cv-faint:     #9BA1A6;
  --cv-rule:      rgba(21,24,27,0.11);
  --cv-rule-firm: rgba(21,24,27,0.26);
  --cv-wash:      rgba(21,24,27,0.028);
}

.cv { overflow-x: hidden; }
.cv ::selection { background: var(--cv-rule-firm); color: var(--cv-bg); }

/* Underlined text link — the only link treatment on the page. */
.cv-u {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid var(--cv-rule-firm);
  padding-bottom: 1px;
  transition: color .18s ease, border-color .18s ease;
}
.cv-u:hover { color: var(--cv-ink); border-bottom-color: currentColor; }

/* Plaza invitation. */
.cv-plaza {
  display: inline-flex;
  align-items: center;
  gap: 14px;
  text-decoration: none;
  color: inherit;
  padding: 14px 18px;
  border: 1px solid var(--cv-rule);
  border-radius: 4px;
  background: var(--cv-wash);
  transition: border-color .2s ease, transform .2s ease;
}
.cv-plaza:hover { border-color: var(--cv-rule-firm); transform: translateY(-1px); }
.cv-plaza-arrow { transition: transform .2s ease; }
.cv-plaza:hover .cv-plaza-arrow { transform: translateX(4px); }

/* Monument stat row — 4 up, 2 up on narrow. */
.cv-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 22px 16px;
}

/* Metadata gutter + content. Collapses to one column on narrow. */
.cv-row {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  gap: 28px;
}

/* Archive line: title block left, metadata right. */
.cv-arch {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 24px;
  align-items: baseline;
}

@media (max-width: 640px) {
  .cv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 14px; }
  .cv-row   { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .cv-arch  { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .cv *, .cv *::before, .cv *::after {
    transition: none !important;
    animation: none !important;
  }
}
`;

// ── small presentational pieces ────────────────────────────────────────

function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 30 }}>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--cv-faint)",
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--cv-rule)" }} />
    </div>
  );
}

function Meta({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 11.5,
        letterSpacing: "0.09em",
        color: "var(--cv-faint)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function Body({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: 16.5,
        lineHeight: 1.72,
        color: "var(--cv-body)",
        ...style,
      }}
    >
      {children}
    </p>
  );
}

/** Stack list — mono, dot-separated. Deliberately not pills. */
function Stack({ items }: { items: string[] }) {
  return (
    <Meta style={{ color: "var(--cv-muted)", lineHeight: 1.9 }}>
      {items.join("  ·  ")}
    </Meta>
  );
}

function LinkRow({
  links,
  style,
}: {
  links: { label: string; href: string }[];
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 20px", ...style }}>
      {links.map((l) => (
        <a
          key={l.href + l.label}
          className="cv-u"
          href={l.href}
          {...(isExternal(l.href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          style={{ fontSize: 14, color: "var(--cv-muted)" }}
        >
          {l.label}
          {isExternal(l.href) && (
            <span aria-hidden style={{ fontSize: 11, marginLeft: 5, opacity: 0.6 }}>↗</span>
          )}
        </a>
      ))}
    </div>
  );
}

// ── sections ───────────────────────────────────────────────────────────

function PlazaInvite() {
  return (
    <Link to="/creative" className="cv-plaza">
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: "50%",
          border: "1px solid var(--cv-rule-firm)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: DISPLAY,
          fontSize: 15,
          color: "var(--cv-ink)",
        }}
      >
        3D
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 15, color: "var(--cv-ink)" }}>Step into the plaza</span>
        <Meta style={{ letterSpacing: "0.06em" }}>the same work, walkable</Meta>
      </span>
      <span
        aria-hidden
        className="cv-plaza-arrow"
        style={{ color: "var(--cv-muted)", fontSize: 17, marginLeft: 4 }}
      >
        →
      </span>
    </Link>
  );
}

function Monument({ project, index }: { project: Project; index: number }) {
  return (
    <article style={{ marginBottom: 74 }}>
      <div aria-hidden style={{ width: 26, height: 2, background: project.color, marginBottom: 14 }} />

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <Meta style={{ color: project.color, fontVariantNumeric: "tabular-nums" }}>
          {String(index + 1).padStart(2, "0")}
        </Meta>
        {project.period && <Meta>{project.period}</Meta>}
      </div>

      <h3
        style={{
          margin: "0 0 12px",
          fontFamily: DISPLAY,
          fontSize: "clamp(30px, 6.5vw, 38px)",
          fontWeight: 500,
          letterSpacing: "-0.5px",
          lineHeight: 1.12,
          color: "var(--cv-ink)",
        }}
      >
        {project.name}
      </h3>

      <p
        style={{
          margin: "0 0 30px",
          fontFamily: DISPLAY,
          fontSize: "clamp(18px, 3.6vw, 20px)",
          lineHeight: 1.5,
          fontStyle: "italic",
          color: "var(--cv-muted)",
        }}
      >
        {project.tagline}
      </p>

      {project.stats && project.stats.length > 0 && (
        <div
          className="cv-stats"
          style={{
            padding: "22px 0",
            borderTop: "1px solid var(--cv-rule)",
            borderBottom: "1px solid var(--cv-rule)",
            marginBottom: 28,
          }}
        >
          {project.stats.map((s) => (
            <div key={s.label} style={{ minWidth: 0 }}>
              <div
                style={{
                  fontFamily: DISPLAY,
                  fontSize: "clamp(24px, 5vw, 29px)",
                  fontWeight: 500,
                  letterSpacing: "-0.4px",
                  lineHeight: 1.05,
                  color: "var(--cv-ink)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {s.value}
              </div>
              <div
                style={{
                  marginTop: 7,
                  fontFamily: MONO,
                  fontSize: 10.5,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--cv-faint)",
                }}
              >
                {s.label}
              </div>
            </div>
          ))}
        </div>
      )}

      {project.blurb && <Body style={{ marginBottom: 22 }}>{project.blurb}</Body>}

      <Stack items={project.stack} />

      {project.links && project.links.length > 0 && (
        <LinkRow links={project.links} style={{ marginTop: 16 }} />
      )}
    </article>
  );
}

function Pylon({ project }: { project: Project }) {
  return (
    <article
      style={{
        borderLeft: `2px solid ${project.color}`,
        paddingLeft: 22,
        marginBottom: 34,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h3
          style={{
            margin: 0,
            fontFamily: DISPLAY,
            fontSize: 23,
            fontWeight: 500,
            letterSpacing: "-0.3px",
            color: "var(--cv-ink)",
          }}
        >
          {project.name}
        </h3>
        {project.period && <Meta>{project.period}</Meta>}
      </div>

      <Body style={{ fontSize: 16, marginTop: 8 }}>{project.tagline}</Body>
      {project.blurb && (
        <Body style={{ fontSize: 15.5, marginTop: 10, color: "var(--cv-muted)" }}>
          {project.blurb}
        </Body>
      )}

      <div style={{ marginTop: 14 }}>
        <Stack items={project.stack} />
      </div>
      {project.links && project.links.length > 0 && (
        <LinkRow links={project.links} style={{ marginTop: 12 }} />
      )}
    </article>
  );
}

function RoleEntry({ role }: { role: Role }) {
  return (
    <div className="cv-row" style={{ marginBottom: 44 }}>
      <div>
        <Meta style={{ display: "block", lineHeight: 1.6 }}>{role.period}</Meta>
        {role.current && (
          <Meta
            style={{
              display: "inline-block",
              marginTop: 6,
              color: "var(--cv-ink)",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              fontSize: 10,
            }}
          >
            Current
          </Meta>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: DISPLAY,
            fontSize: 21,
            fontWeight: 500,
            letterSpacing: "-0.2px",
            lineHeight: 1.3,
            color: "var(--cv-ink)",
          }}
        >
          {role.org}
        </div>
        <div style={{ marginTop: 4, fontSize: 15, color: "var(--cv-muted)", lineHeight: 1.5 }}>
          {role.title}
        </div>
        <Meta style={{ display: "block", marginTop: 6 }}>{role.location}</Meta>

        <ul style={{ listStyle: "none", padding: 0, margin: "16px 0 0" }}>
          {role.points.map((pt) => (
            <li
              key={pt}
              style={{
                position: "relative",
                paddingLeft: 18,
                marginBottom: 10,
                fontSize: 15.5,
                lineHeight: 1.66,
                color: "var(--cv-body)",
              }}
            >
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  left: 0,
                  top: "0.62em",
                  width: 5,
                  height: 1,
                  background: "var(--cv-rule-firm)",
                }}
              />
              {pt}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function EducationEntry({ entry }: { entry: Education }) {
  return (
    <div className="cv-row">
      <Meta style={{ display: "block", lineHeight: 1.6 }}>{entry.period}</Meta>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: DISPLAY,
            fontSize: 21,
            fontWeight: 500,
            letterSpacing: "-0.2px",
            color: "var(--cv-ink)",
          }}
        >
          {entry.school}
        </div>
        <div style={{ marginTop: 5, fontSize: 15.5, color: "var(--cv-body)", lineHeight: 1.6 }}>
          {entry.credential}
        </div>
        {entry.detail && <Meta style={{ display: "block", marginTop: 7 }}>{entry.detail}</Meta>}
      </div>
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────

function CvPage() {
  return (
    <div
      className="cv"
      style={{
        minHeight: "100vh",
        fontFamily: FONT,
        color: "var(--cv-body)",
        background: "var(--cv-bg)",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <style>{CSS}</style>
      {/* Paints the overscroll gutter the page colour instead of white. */}
      <div aria-hidden style={{ position: "fixed", inset: 0, background: "var(--cv-bg)", zIndex: -1 }} />

      <main style={{ maxWidth: MAX_W, margin: "0 auto", padding: "clamp(56px, 12vw, 104px) 24px 120px" }}>

        {/* ── hero ───────────────────────────────────────────────── */}
        <header style={{ marginBottom: 52 }}>
          <h1
            style={{
              margin: 0,
              fontFamily: DISPLAY,
              fontSize: "clamp(42px, 10vw, 64px)",
              fontWeight: 500,
              letterSpacing: "-1.4px",
              lineHeight: 1.02,
              color: "var(--cv-ink)",
            }}
          >
            {PROFILE.name}
          </h1>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "6px 14px",
              marginTop: 20,
              alignItems: "center",
            }}
          >
            <Meta style={{ color: "var(--cv-muted)" }}>{PROFILE.role}</Meta>
            <Meta aria-hidden>/</Meta>
            <Meta>{PROFILE.location}</Meta>
          </div>

          <p
            style={{
              margin: "30px 0 0",
              fontFamily: DISPLAY,
              fontSize: "clamp(20px, 4.4vw, 25px)",
              lineHeight: 1.5,
              letterSpacing: "-0.2px",
              color: "var(--cv-ink)",
            }}
          >
            {PROFILE.thesis}
          </p>
        </header>

        <div style={{ marginBottom: 84 }}>
          <PlazaInvite />
        </div>

        {/* ── now ────────────────────────────────────────────────── */}
        <section style={{ marginBottom: 88 }}>
          <SectionHead>Now</SectionHead>
          <Body>{PROFILE.now}</Body>
          <Body style={{ marginTop: 20, color: "var(--cv-muted)" }}>{PROFILE.origin}</Body>
        </section>

        {/* ── monuments ──────────────────────────────────────────── */}
        {MONUMENTS.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <SectionHead>Selected work</SectionHead>
            {MONUMENTS.map((p, i) => (
              <Monument key={p.id} project={p} index={i} />
            ))}
          </section>
        )}

        {/* ── pylons ─────────────────────────────────────────────── */}
        {PYLONS.length > 0 && (
          <section style={{ marginBottom: 88 }}>
            <SectionHead>Also built</SectionHead>
            {PYLONS.map((p) => (
              <Pylon key={p.id} project={p} />
            ))}
          </section>
        )}

        {/* ── experience ─────────────────────────────────────────── */}
        {ROLES.length > 0 && (
          <section style={{ marginBottom: 44 }}>
            <SectionHead>Experience</SectionHead>
            {ROLES.map((r) => (
              <RoleEntry key={`${r.org}-${r.period}`} role={r} />
            ))}
          </section>
        )}

        {/* ── education ──────────────────────────────────────────── */}
        {EDUCATION.length > 0 && (
          <section style={{ marginBottom: 88 }}>
            <SectionHead>Education</SectionHead>
            {EDUCATION.map((e) => (
              <EducationEntry key={e.school} entry={e} />
            ))}
          </section>
        )}

        {/* ── skills ─────────────────────────────────────────────── */}
        {SKILLS.length > 0 && (
          <section style={{ marginBottom: 88 }}>
            <SectionHead>Skills</SectionHead>
            {SKILLS.map((g) => (
              <div key={g.group} className="cv-row" style={{ marginBottom: 22 }}>
                <Meta style={{ display: "block", lineHeight: 1.7 }}>{g.group}</Meta>
                <Body style={{ fontSize: 15.5 }}>{g.items.join("  ·  ")}</Body>
              </div>
            ))}
          </section>
        )}

        {/* ── archive ────────────────────────────────────────────── */}
        {ARCHIVE.length > 0 && (
          <section style={{ marginBottom: 96 }}>
            <SectionHead>Archive</SectionHead>
            {ARCHIVE.map((p) => (
              <div
                key={p.id}
                className="cv-arch"
                style={{ padding: "16px 0", borderTop: "1px solid var(--cv-rule)" }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                    <span
                      style={{
                        fontFamily: DISPLAY,
                        fontSize: 18,
                        fontWeight: 500,
                        letterSpacing: "-0.2px",
                        color: "var(--cv-ink)",
                      }}
                    >
                      {p.name}
                    </span>
                    {p.period && <Meta>{p.period}</Meta>}
                  </div>
                  <div style={{ marginTop: 5, fontSize: 14.5, lineHeight: 1.6, color: "var(--cv-muted)" }}>
                    {p.tagline}
                  </div>
                  <div style={{ marginTop: 7 }}>
                    <Stack items={p.stack} />
                  </div>
                </div>
                {p.links && p.links.length > 0 && <LinkRow links={p.links} />}
              </div>
            ))}
          </section>
        )}

        {/* ── footer ─────────────────────────────────────────────── */}
        <footer style={{ paddingTop: 32, borderTop: "1px solid var(--cv-rule)" }}>
          <LinkRow
            links={[...PROFILE.links, { label: "Résumé (PDF)", href: PROFILE.resumeHref }]}
            style={{ gap: "12px 24px" }}
          />
          <div style={{ marginTop: 26 }}>
            <Link className="cv-u" to="/creative" style={{ fontSize: 14, color: "var(--cv-muted)" }}>
              Or walk through it in 3D
              <span aria-hidden style={{ marginLeft: 6, opacity: 0.6 }}>→</span>
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
