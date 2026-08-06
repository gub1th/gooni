// /public/cv: the flat text portfolio. The "fast lane" out of the 3D
// plaza at /creative: everything a recruiter on a phone needs, in one
// column, no WebGL, no chrome.
//
// ALL copy comes from ../content/portfolio; this file owns layout and
// typography only. If a fact is missing here, add it there.
//
// Three type registers, one job each. Don't add a fourth:
//   DISPLAY  proper nouns (his name, project names, orgs, schools)
//   MONO     metadata (eyebrows, periods, stacks, stat lines)
//   FONT     body prose, taglines, role titles
// The italic-serif tagline and the bordered grid of giant serif stat
// figures are gone on purpose: they were decoration standing in for the
// screenshots the page already had the data to show.
//
// /public/* renders bare (see isChromelessPath in __root.tsx), so this
// page owns its own palette. Theme handling is a scoped <style> block of
// CSS custom properties: prefers-color-scheme for the OS default, plus
// :root[data-theme="…"] overrides (higher specificity, so an explicit
// app-set theme always wins); inline styles then read var(--cv-*).

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
.cv-plaza:hover { border-color: rgba(74,222,128,0.55); transform: translateY(-2px); }
.cv-plaza-arrow { transition: transform .2s ease; }
.cv-plaza:hover .cv-plaza-arrow { transform: translateX(4px); }

/* Before / After: raw log -> parsed spreadsheet, side by side. */
.cv-ba {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 16px;
  align-items: center;
  margin-top: 36px;
}
.cv-ba figure { margin: 0; min-width: 0; }
.cv-ba img {
  width: 100%;
  height: auto;
  display: block;
  border: 1px solid var(--cv-rule);
  border-radius: 10px;
  background: var(--cv-wash);
}
.cv-ba-arrow { color: var(--cv-faint); font-size: 22px; text-align: center; }
@media (max-width: 640px) {
  .cv-ba { grid-template-columns: 1fr; }
  .cv-ba-arrow { transform: rotate(90deg); }
}

/* Project row: prose left, screenshot right. Applied to EVERY project,
   including the ones with no screenshot yet: the empty right column keeps
   one measure down the whole section, and a project that runs full width
   next to one that doesn't reads like a layout bug. */
.cv-proj {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 212px;
  gap: 30px;
  align-items: start;
}
.cv-shot {
  width: 100%;
  height: auto;
  display: block;
  border: 1px solid var(--cv-rule);
  border-radius: 8px;
  background: var(--cv-wash);
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
  .cv-proj { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .cv-row  { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .cv-arch { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .cv *, .cv *::before, .cv *::after {
    transition: none !important;
    animation: none !important;
  }
}
`;

// ── small presentational pieces ────────────────────────────────────────

// Just the label. The trailing hairline this used to draw is the stock
// editorial-template move, and it was the loudest thing on every section.
function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginBottom: 30,
        fontFamily: MONO,
        fontSize: 11,
        letterSpacing: "0.2em",
        textTransform: "uppercase",
        color: "var(--cv-faint)",
      }}
    >
      {children}
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

/** Stack list: mono, dot-separated. Deliberately not pills. */
function Stack({ items }: { items: string[] }) {
  return (
    <Meta style={{ color: "var(--cv-muted)", lineHeight: 1.9 }}>
      {items.join("  ·  ")}
    </Meta>
  );
}

/** The numbers, as one mono line in the same voice as the stack.
 *  They used to be a bordered four-up grid of giant serif figures, which
 *  made checkable facts look like résumé decoration. */
function StatLine({ stats }: { stats: { value: string; label: string }[] }) {
  return (
    <Meta
      style={{
        display: "block",
        color: "var(--cv-muted)",
        lineHeight: 1.9,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {stats.map((s) => `${s.value} ${s.label}`).join("  ·  ")}
    </Meta>
  );
}

/** Project screenshot. The data has carried these all along; the page
 *  never rendered them, so every claim was told rather than shown. */
function Shot({ project }: { project: Project }) {
  if (!project.image) return null;
  return (
    <img className="cv-shot" src={project.image} alt={project.imageAlt ?? ""} loading="lazy" />
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
    <Link to="/public" className="cv-plaza">
      <span
        aria-hidden
        style={{
          width: 40,
          height: 40,
          flexShrink: 0,
          borderRadius: "50%",
          background: "rgba(74,222,128,0.14)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <WalkingGooni />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 15, color: "var(--cv-ink)" }}>Wander the plaza</span>
        <Meta style={{ letterSpacing: "0.06em" }}>explore in 3D</Meta>
      </span>
      <span
        aria-hidden
        className="cv-plaza-arrow"
        style={{ color: "#4ADE80", fontSize: 18, marginLeft: 4 }}
      >
        →
      </span>
    </Link>
  );
}

// The little Gooni marching in place — lifted from the original /public
// plaza CTA (the version Daniel liked). SVG, self-contained keyframes.
function WalkingGooni() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
      <g style={{ animation: "plazaCtaWalkBob 0.5s ease-in-out infinite" }}>
        <circle cx="15" cy="8" r="5" fill="#F5F5F0" />
        <circle cx="14" cy="7.5" r="1" fill="#1a1a1a" />
        <circle cx="14.3" cy="7.2" r="0.3" fill="#fff" />
        <path d="M13 9.5 Q14.5 10.8 15.5 9.8" stroke="#1a1a1a" strokeWidth="0.5" fill="none" />
        <rect x="12" y="13" width="6" height="6" rx="2" fill="#4ADE80" />
        <rect
          x="10.5" y="14.5" width="2" height="1.2" rx="0.6" fill="#4ADE80"
          style={{ animation: "plazaCtaArmBack 0.5s ease-in-out infinite", transformOrigin: "12.5px 14.5px" }}
        />
        <rect
          x="17.5" y="14.5" width="2" height="1.2" rx="0.6" fill="#4ADE80"
          style={{ animation: "plazaCtaArmFront 0.5s ease-in-out infinite", transformOrigin: "17.5px 14.5px" }}
        />
        <rect
          x="12.5" y="19" width="1.8" height="3" rx="0.7" fill="#3AAD6E"
          style={{ animation: "plazaCtaLegFront 0.5s ease-in-out infinite", transformOrigin: "13.4px 19px" }}
        />
        <rect
          x="15.5" y="19" width="1.8" height="3" rx="0.7" fill="#3AAD6E"
          style={{ animation: "plazaCtaLegBack 0.5s ease-in-out infinite", transformOrigin: "16.4px 19px" }}
        />
      </g>
      <style>{`
        @keyframes plazaCtaWalkBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
        @keyframes plazaCtaLegFront { 0%,100% { transform: rotate(-15deg); } 50% { transform: rotate(15deg); } }
        @keyframes plazaCtaLegBack { 0%,100% { transform: rotate(15deg); } 50% { transform: rotate(-15deg); } }
        @keyframes plazaCtaArmFront { 0%,100% { transform: rotate(10deg); } 50% { transform: rotate(-10deg); } }
        @keyframes plazaCtaArmBack { 0%,100% { transform: rotate(-10deg); } 50% { transform: rotate(10deg); } }
      `}</style>
    </svg>
  );
}

// The trading-log origin, shown: raw logger output on the left, the same data
// parsed into a reviewable spreadsheet on the right. Stacks on narrow screens.
function BeforeAfter() {
  const cap: React.CSSProperties = {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "var(--cv-faint)",
    marginBottom: 10,
    display: "block",
  };
  return (
    <div className="cv-ba">
      <figure>
        <span style={cap}>Before</span>
        <img
          src="/portfolio/logger.jpg"
          alt="Raw trading-log output: dense market data, execution flags and reject reasons."
          loading="lazy"
        />
      </figure>
      <span aria-hidden className="cv-ba-arrow">→</span>
      <figure>
        <span style={cap}>After</span>
        <img
          src="/portfolio/logger-excel.webp"
          alt="The same data parsed by a Python script into a clean, reviewable spreadsheet."
          loading="lazy"
        />
      </figure>
    </div>
  );
}

function Monument({ project, index }: { project: Project; index: number }) {
  return (
    <article className="cv-proj" style={{ marginBottom: 64 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
          <Meta style={{ color: project.color, fontVariantNumeric: "tabular-nums" }}>
            {String(index + 1).padStart(2, "0")}
          </Meta>
          {project.period && <Meta>{project.period}</Meta>}
        </div>

        <h3
          style={{
            margin: "0 0 10px",
            fontFamily: DISPLAY,
            fontSize: "clamp(28px, 5.5vw, 34px)",
            fontWeight: 500,
            letterSpacing: "-0.5px",
            lineHeight: 1.12,
            color: "var(--cv-ink)",
          }}
        >
          {project.name}
        </h3>

        <Body style={{ fontSize: 17, color: "var(--cv-ink)", marginBottom: 14 }}>
          {project.tagline}
        </Body>

        {project.blurb && <Body style={{ marginBottom: 16 }}>{project.blurb}</Body>}

        {project.stats && project.stats.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <StatLine stats={project.stats} />
          </div>
        )}

        <Stack items={project.stack} />

        {project.links && project.links.length > 0 && (
          <LinkRow links={project.links} style={{ marginTop: 16 }} />
        )}
      </div>

      <Shot project={project} />
    </article>
  );
}

function Pylon({ project }: { project: Project }) {
  return (
    <article className="cv-proj" style={{ marginBottom: 40 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", background: project.color, flexShrink: 0 }} />
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

        <Body style={{ fontSize: 16, marginTop: 8, color: "var(--cv-ink)" }}>{project.tagline}</Body>
        {project.blurb && (
          <Body style={{ fontSize: 15.5, marginTop: 10 }}>{project.blurb}</Body>
        )}

        <div style={{ marginTop: 14 }}>
          <Stack items={project.stack} />
        </div>
        {project.links && project.links.length > 0 && (
          <LinkRow links={project.links} style={{ marginTop: 12 }} />
        )}
      </div>

      <Shot project={project} />
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

          <Body style={{ marginTop: 22, maxWidth: 620 }}>{PROFILE.now}</Body>

          {/* The story is worth reading but it isn't what a recruiter opened
              this page for, so it sits at the bottom behind an opt-in jump. */}
          <div style={{ marginTop: 20 }}>
            <a className="cv-u" href="#story" style={{ fontSize: 14, color: "var(--cv-muted)" }}>
              A longer TLDR
              <span aria-hidden style={{ marginLeft: 6, opacity: 0.6 }}>↓</span>
            </a>
          </div>
        </header>

        <div style={{ marginBottom: 84 }}>
          <PlazaInvite />
        </div>

        {/* ── monuments ──────────────────────────────────────────── */}
        {MONUMENTS.length > 0 && (
          // Trailing Monument carries 64px below; +24 holds the 88px rhythm.
          <section style={{ marginBottom: 24 }}>
            <SectionHead>Selected work</SectionHead>
            {MONUMENTS.map((p, i) => (
              <Monument key={p.id} project={p} index={i} />
            ))}
          </section>
        )}

        {/* ── pylons ─────────────────────────────────────────────── */}
        {PYLONS.length > 0 && (
          // Trailing Pylon carries 40px below; +48 holds the rhythm.
          <section style={{ marginBottom: 48 }}>
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
          // Trailing skills row carries 22px below; +66 holds the rhythm.
          <section style={{ marginBottom: 66 }}>
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
          <section style={{ marginBottom: 88 }}>
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

        {/* ── how I started ──────────────────────────────────────── */}
        {/* Target of the hero's "A longer TLDR" jump. */}
        <section id="story" style={{ marginBottom: 88, scrollMarginTop: 40 }}>
          <SectionHead>How I started</SectionHead>
          {PROFILE.story.map((para, i) => (
            <Body key={i} style={{ marginTop: i === 0 ? 0 : 18 }}>
              {para}
            </Body>
          ))}
          <BeforeAfter />
        </section>

        {/* ── what I'm looking for ───────────────────────────────── */}
        {/* Last section before the contact links: it reads as the ask. */}
        <section style={{ marginBottom: 88 }}>
          <SectionHead>What I'm looking for</SectionHead>
          {PROFILE.looking.map((para, i) => (
            <Body key={i} style={{ marginTop: i === 0 ? 0 : 18 }}>
              {para}
            </Body>
          ))}
        </section>

        {/* ── footer ─────────────────────────────────────────────── */}
        <footer style={{ paddingTop: 32, borderTop: "1px solid var(--cv-rule)" }}>
          <LinkRow
            links={[...PROFILE.links, { label: "Résumé (PDF)", href: PROFILE.resumeHref }]}
            style={{ gap: "12px 24px" }}
          />
          <div style={{ marginTop: 26 }}>
            <Link className="cv-u" to="/public" style={{ fontSize: 14, color: "var(--cv-muted)" }}>
              Or walk through it in 3D
              <span aria-hidden style={{ marginLeft: 6, opacity: 0.6 }}>→</span>
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
