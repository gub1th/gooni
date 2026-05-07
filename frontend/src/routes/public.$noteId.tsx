import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { sanitizeHtml } from "../utils/sanitize";
import { displayTitle } from "../utils/notePreview";
import { NoteLoadingState } from "../components/NoteLoadingState";
import { publicNoteQueryOptions } from "../utils/publicQueries";

export const Route = createFileRoute("/public/$noteId")({
  component: PublicNotePage,
});

function formatPublicDate(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

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
  const parse = (iso: string) => {
    const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
    return new Date(hasOffset ? iso : iso + "Z").getTime();
  };
  const gapMs = parse(updatedAt) - parse(createdAt);
  return gapMs > 12 * 60 * 60 * 1000;
}

function PublicNotePage() {
  const { noteId } = Route.useParams();
  const id = Number(noteId);
  const { data: note, isLoading, isError } = useQuery(publicNoteQueryOptions(id));
  const notFound = isError;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#fff",
        fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        color: "#111",
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 24px 120px" }}>
        {/* Back link */}
        <Link
          to="/public"
          style={{ fontSize: 13.5, color: "#888", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 40 }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#111")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#888")}
        >
          ← back
        </Link>

        {notFound ? (
          <p style={{ color: "#aaa", fontSize: 15 }}>Note not found or not public.</p>
        ) : isLoading || !note ? (
          <NoteLoadingState />
        ) : (
          <>
            {note.space_name && (
              <span style={{ fontSize: 11.5, color: "#888", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12, padding: "2px 8px", marginBottom: 16, display: "inline-block" }}>
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
            <p style={{ fontSize: 13, color: "#AEAEB2", margin: "0 0 52px", letterSpacing: 0.1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
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
              /* First heading in content shouldn't double-space against the meta line. */
              .public-prose > :first-child { margin-top: 0; }
            `}</style>
            <div
              className="public-prose"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(note.content || "") }}
            />
          </>
        )}
      </div>
    </div>
  );
}
