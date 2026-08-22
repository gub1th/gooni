import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { sanitizeHtml } from "../utils/sanitize";
import { displayTitle } from "../utils/notePreview";
import { NoteLoadingState } from "../components/NoteLoadingState";
import { publicNoteQueryOptions } from "../utils/publicQueries";
import { AttachmentModal } from "../components/notes/AttachmentModal";
import { useNoteCardStyles } from "../components/notes/noteCardStyles";
import { color as ctok } from "../ui";
import { formatLongDate as formatPublicDate, parseServerDate } from "../utils/date";

export const Route = createFileRoute("/public/$noteId")({
  component: PublicNotePage,
});

function readingTimeMin(html: string | null): number {
  if (!html) return 1;
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return Math.max(1, Math.ceil(text.length / 1000));
}

// Auto-save bumps updated_at within seconds of creation, so naively showing
// both always looks noisy. Only surface the "Updated" line when the gap
// is meaningful — I use 12h as the cutoff, which feels like a real
// revisit/edit rather than part of the original authoring session.
function showUpdated(createdAt: string, updatedAt: string): boolean {
  const created = parseServerDate(createdAt);
  const updated = parseServerDate(updatedAt);
  if (!created || !updated) return false;
  const gapMs = updated.getTime() - created.getTime();
  return gapMs > 12 * 60 * 60 * 1000;
}

interface AttachmentPreviewState {
  url: string;
  filename: string;
  mime: string;
  size: number;
}

function PublicNotePage() {
  useNoteCardStyles();
  const { noteId } = Route.useParams();
  const id = Number(noteId);
  const { data: note, isLoading, isError } = useQuery(publicNoteQueryOptions(id));
  const notFound = isError;
  const proseRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<AttachmentPreviewState | null>(null);
  const navigate = useNavigate();

  // Intercept clicks on attachment cards rendered inside the sanitized HTML
  // so they open the inline modal preview instead of navigating to the raw
  // R2 URL. Also intercept NoteLink chips so they route in-app via the
  // public/:noteId page rather than triggering the href="#" anchor jump.
  useEffect(() => {
    const container = proseRef.current;
    if (!container) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const noteChip = target.closest("a[data-note-link]") as HTMLAnchorElement | null;
      if (noteChip) {
        e.preventDefault();
        const childId = Number(noteChip.getAttribute("data-note-id") || "");
        if (childId) {
          navigate({ to: "/public/$noteId", params: { noteId: String(childId) } });
        }
        return;
      }
      const card = target.closest("[data-attachment]") as HTMLElement | null;
      if (!card) return;
      e.preventDefault();
      const url = card.getAttribute("data-url") || "";
      const filename = card.getAttribute("data-filename") || "attachment";
      const mime = card.getAttribute("data-mime") || "application/octet-stream";
      const size = parseInt(card.getAttribute("data-size") || "0", 10) || 0;
      if (!url) return;
      setPreview({ url, filename, mime, size });
    };
    container.addEventListener("click", handler);
    return () => container.removeEventListener("click", handler);
  }, [note?.content, navigate]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--gooni-card, #fff)",
        fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        color: "var(--gooni-text, #111)",
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 24px 120px" }}>
        {/* Back link */}
        <Link
          to="/public/notes"
          style={{ fontSize: 13.5, color: "var(--gooni-muted, #888)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 40 }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#111")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#888")}
        >
          ← back
        </Link>

        {notFound ? (
          <p style={{ color: "var(--gooni-faint, #aaa)", fontSize: 15 }}>Note not found or not public.</p>
        ) : isLoading || !note ? (
          <NoteLoadingState />
        ) : (
          <>
            {note.space_name && (
              <span style={{ fontSize: 11.5, color: "var(--gooni-muted, #888)", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12, padding: "2px 8px", marginBottom: 16, display: "inline-block" }}>
                {note.space_name}
              </span>
            )}
            <h1
              style={{
                fontSize: 40,
                fontWeight: 600,
                letterSpacing: "-1px",
                margin: "12px 0 10px",
                lineHeight: 1.15,
              }}
            >
              {displayTitle(note)}
            </h1>
            <p style={{ fontSize: 13, color: ctok.faint, margin: "0 0 52px", letterSpacing: 0.1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {/* clock icon — inline SVG matches the meta line color via currentColor */}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.1" fill="none" />
                <path d="M6 3.2V6L8 7.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{readingTimeMin(note.content)} min read</span>
              <span style={{ color: "#D1D1D6" }}>·</span>
              <span>Published {formatPublicDate(note.created_at)}</span>
              {showUpdated(note.created_at, note.updated_at) && (
                <>
                  <span style={{ color: "#D1D1D6" }}>·</span>
                  <span>Updated {formatPublicDate(note.updated_at)}</span>
                </>
              )}
              <span style={{ color: "#D1D1D6" }}>·</span>
              {/* Eye icon — currentColor matches the rest of the meta line. */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span>{note.unique_viewers.toLocaleString()} {note.unique_viewers === 1 ? "viewer" : "viewers"}</span>
            </p>
            {/* Scoped prose styles — override browser defaults so injected H1/H2/H3
                in note content never out-shout the title. See sanitizeHtml for the
                upstream XSS guard on the content string. */}
            <style>{`
              .public-prose { font-size: 16px; line-height: 1.75; color: #222; }
              .public-prose h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.4px;
                                 margin: 40px 0 10px; line-height: 1.25; }
              .public-prose h2 { font-size: 22px; font-weight: 600; letter-spacing: -0.2px;
                                 margin: 36px 0 8px; line-height: 1.3; }
              .public-prose h3 { font-size: 18px; font-weight: 600;
                                 margin: 28px 0 6px; line-height: 1.35; }
              .public-prose h4 { font-size: 15.5px; font-weight: 600; color: #444;
                                 margin: 22px 0 4px; }
              .public-prose p  { margin: 0 0 16px; }
              .public-prose ul, .public-prose ol { margin: 0 0 16px; padding-left: 22px; }
              .public-prose li { margin: 4px 0; }
              .public-prose code { background: rgba(0,0,0,0.05); padding: 1px 5px;
                                   border-radius: 4px; font-size: 14px;
                                   font-family: 'SF Mono', Menlo, Monaco, monospace; }
              .public-prose pre { background: #F7F7F8; padding: 14px 16px; border-radius: 8px;
                                  overflow-x: auto; font-size: 13.5px; line-height: 1.55;
                                  margin: 0 0 20px; }
              .public-prose pre code { background: transparent; padding: 0; font-size: inherit; }
              .public-prose blockquote { margin: 18px 0; padding: 4px 0 4px 16px;
                                          border-left: 3px solid rgba(0,0,0,0.12); color: #555; }
              .public-prose img { max-width: 100%; height: auto; border-radius: 8px;
                                  margin: 12px 0; }
              /* Figure node — keeps the same alignment / width / caption shape
                 the editor produces. width comes through as a CSS custom
                 property on the figure (--figure-width), with class-based
                 alignment + float layout for side-by-side images. */
              .public-prose .gooni-figure { width: var(--figure-width, 100%);
                                            box-sizing: border-box; padding: 0; }
              .public-prose .gooni-figure img { width: 100%; height: auto;
                                                border-radius: 8px; display: block;
                                                margin: 0; }
              .public-prose .gooni-figure-center { float: none; clear: both;
                                                   margin: 12px auto; }
              .public-prose .gooni-figure-left   { float: left;  clear: none;
                                                   margin: 12px 14px 12px 0; }
              .public-prose .gooni-figure-right  { float: right; clear: none;
                                                   margin: 12px 0 12px 14px; }
              .public-prose .gooni-figure figcaption {
                  margin-top: 6px; font-size: 13px; line-height: 1.4;
                  color: #6E6E73; text-align: center;
              }
              /* Clear floats so the next block-level element sits below
                 a row of side-by-side figures. */
              .public-prose .gooni-figure + p::after,
              .public-prose .gooni-figure + h1::after,
              .public-prose .gooni-figure + h2::after,
              .public-prose .gooni-figure + h3::after { content: ""; display: block; clear: both; }
              .public-prose a { color: #2B6CB0; text-decoration: underline;
                                text-decoration-thickness: 1px; text-underline-offset: 2px; }
              .public-prose a:hover { color: #1A4F8C; }
              /* Tables — mirror the editor styling so public renders match what
                 you see while writing. Browsers default to borderless tables, so
                 without these rules a TipTap table just looks like floating cells. */
              .public-prose table { border-collapse: collapse; width: 100%;
                                    margin: 16px 0; font-size: 14px;
                                    display: block; overflow-x: auto; }
              .public-prose table td, .public-prose table th {
                  border: 1px solid rgba(0,0,0,0.12); padding: 6px 10px;
                  min-width: 80px; vertical-align: top; }
              .public-prose table th { background: rgba(0,0,0,0.04); font-weight: 600;
                                       text-align: left; }
              /* Attachment cards — mirror the editor NodeView styling so
                 public + private renders look identical. The inner <a>
                 still has a real href, so any non-JS click falls back to
                 a new-tab open of the R2 URL. */
              .public-prose .gooni-attachment-card {
                  display: block; border: 1px solid rgba(0,0,0,0.12);
                  border-radius: 10px; background: #FAFAFA;
                  padding: 10px; margin: 14px 0; cursor: pointer;
                  transition: background 120ms ease;
              }
              .public-prose .gooni-attachment-card:hover { background: #F2F2F4; }
              .public-prose .gooni-attachment-card .gooni-attachment-link {
                  display: flex; align-items: center; gap: 10px;
                  text-decoration: none; color: inherit;
              }
              .public-prose .gooni-attachment-card .gooni-attachment-icon {
                  display: inline-flex; align-items: center; justify-content: center;
                  width: 38px; height: 38px; border-radius: 8px;
                  background: rgba(45,125,255,0.10); color: #2D7DFF;
                  font-size: 11px; font-weight: 600; letter-spacing: 0.3px;
                  flex-shrink: 0;
              }
              .public-prose .gooni-attachment-card .gooni-attachment-meta {
                  display: flex; flex-direction: column; min-width: 0; gap: 2px;
              }
              .public-prose .gooni-attachment-card .gooni-attachment-name {
                  font-size: 14px; font-weight: 500; color: #1C1C1E;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
              }
              .public-prose .gooni-attachment-card .gooni-attachment-sub {
                  font-size: 12px; color: #8E8E93;
              }
              /* Confluence-style external-link cards — short wide layout
                 with title + description on the left and an optional og:image
                 thumbnail on the right. Whole card is the <a>, so clicking
                 anywhere opens the URL in a new tab. */
              .public-prose a.gooni-link-card {
                  display: inline-flex; align-items: center; gap: 7px;
                  max-width: 100%;
                  border: 1px solid rgba(0,0,0,0.12); border-radius: 6px;
                  margin: 2px 0; padding: 2px 8px;
                  background: #FAFAFA; line-height: 1.45;
                  text-decoration: none; color: inherit;
                  transition: background 120ms;
              }
              .public-prose a.gooni-link-card:hover { background: #F2F2F4; }
              .public-prose a.gooni-link-card .gooni-link-card-title {
                  font-size: 13.5px; font-weight: 500; color: #1C1C1E;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                  min-width: 0;
              }
              .public-prose a.gooni-link-card .gooni-link-card-site {
                  font-size: 11.5px; color: #8E8E93; flex-shrink: 0;
              }
              /* Older notes stored the chunky shape (body wrapper, description,
                 thumbnail). Those spans are still in their saved HTML, so they
                 are hidden rather than left to render a card this CSS no longer
                 styles — the title/site spans inside the body wrapper still
                 show, which is exactly the smartlink. */
              .public-prose a.gooni-link-card .gooni-link-card-body {
                  display: contents;
              }
              .public-prose a.gooni-link-card .gooni-link-card-desc,
              .public-prose a.gooni-link-card .gooni-link-card-thumb {
                  display: none;
              }
              /* First heading in content shouldn't double-space against the meta line. */
              .public-prose > :first-child { margin-top: 0; }
            `}</style>
            {/* data-public-view attribute is consumed by noteCardStyles.ts —
                makes the NoteCard check non-interactive (cursor + pointer
                events off) since public viewers can't toggle anything. The
                check stays visible to convey checked state; color + checked
                render the same as the editor. */}
            <div
              ref={proseRef}
              className="public-prose"
              data-public-view="true"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(note.content || "") }}
            />
          </>
        )}
      </div>
      {preview && (
        <AttachmentModal
          url={preview.url}
          filename={preview.filename}
          mime={preview.mime}
          size={preview.size}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
