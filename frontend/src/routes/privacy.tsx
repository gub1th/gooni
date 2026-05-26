import { createFileRoute } from "@tanstack/react-router";
import { color as ctok, FONT } from "../ui";


// Single-tenant privacy page. Required for OAuth provider registration
// (Whoop, Google, GitHub all ask for a privacy URL during app setup).
// Content reflects the actual data model: Daniel's notes, chats, and
// integration tokens live in his self-hosted SQLite + go nowhere else.
function PrivacyPage() {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "60px 24px 80px",
        fontFamily: FONT,
        color: ctok.text,
        lineHeight: 1.65,
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ fontSize: 12, color: ctok.muted, marginBottom: 32 }}>Last updated: 2026-05-04</p>

      <Section title="What Gooni is">
        Gooni is a personal AI notebook + assistant operated as a single-user
        application. It is not offered as a multi-tenant service. The only
        person whose data Gooni stores is the operator of the deployed instance.
      </Section>

      <Section title="What we collect">
        <ul style={ulStyle}>
          <li>Notes, conversations, lists, focuses, memories you create.</li>
          <li>OAuth tokens for connected integrations (Google Calendar, GitHub, Whoop). Stored in the application database.</li>
          <li>For Whoop: daily recovery, HRV, RHR, strain, sleep totals — pulled via the Whoop developer API after you grant access.</li>
          <li>Anonymous request logs (path + status) for debugging.</li>
        </ul>
      </Section>

      <Section title="How we use it">
        Data powers the application's personal-assistant features for the
        single operator: chat replies, dashboard summaries, daily nudges, and
        cross-source memory. No data is shared with third parties beyond the
        LLM providers (OpenAI / Anthropic) used to generate replies.
      </Section>

      <Section title="Where it lives">
        Data is stored in a SQLite database on the operator's deployment
        (Fly.io for backend, Vercel for frontend). It is not synced to any
        external analytics, advertising, or data-broker service.
      </Section>

      <Section title="Third-party processors">
        <ul style={ulStyle}>
          <li><strong>OpenAI / Anthropic</strong> — receive prompts + retrieval context to generate replies.</li>
          <li><strong>Whoop, Google, GitHub</strong> — only the OAuth-scoped data the user explicitly authorized.</li>
          <li><strong>Tavily</strong> — receives search queries when the web_search tool fires.</li>
        </ul>
      </Section>

      <Section title="Retention + deletion">
        Data persists until the operator deletes it from the database or
        revokes integration access. Disconnecting an integration via Settings
        deletes its OAuth token and stops further syncs; existing cached
        snapshots remain until manually purged.
      </Section>

      <Section title="Contact">
        Operator email: danielfgunawan1@gmail.com. For data deletion requests
        or questions, email the operator directly.
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>{title}</h2>
      <div style={{ fontSize: 14, color: "var(--gooni-text, #3C3C43)" }}>{children}</div>
    </section>
  );
}

const ulStyle: React.CSSProperties = {
  paddingLeft: 22,
  margin: "6px 0",
};

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});
