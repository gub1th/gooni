// The walk — station copy for the converged portfolio.
//
// One spine, two renderings: the DOM sections a reader scrolls, and the
// 3D world those sections move the camera through. Both read from here,
// so there is no "3D version" and "text version" to drift apart.
//
// Voice note: prose here is Daniel's own, lifted from danis-website
// where it existed rather than rewritten. Where it didn't exist it's
// built from the résumé and his own account of Gooni's evolution. He
// publicly frames the trading-log work as "a relative I worked with" —
// keep that framing.

export type StationId =
  | "origin"
  | "atlassian"
  | "kreatify"
  | "gooni"
  | "edge";

export type Beat = {
  text: string;
  /** Cut beats render struck through with the reason. */
  cut?: boolean;
  why?: string;
};

export type Station = {
  id: StationId;
  /** Small label above the heading. */
  eyebrow: string;
  title: string;
  /** Mono sub-line: dates, role, scale. */
  meta?: string;
  /** Body paragraphs. */
  body: string[];
  /** Optional pull-quote sized line. */
  pull?: string;
  stats?: { value: string; label: string }[];
  beats?: Beat[];
  links?: { label: string; href: string }[];
  image?: string;
  imageAlt?: string;
  /** Optional "after" image. When set, `image` and `imageAfter` render as a
      before→after pair rather than one screenshot. */
  imageAfter?: string;
  imageAfterAlt?: string;
  /** Accent for this leg of the walk. */
  color: string;
  /** 0–1: how cluttered the world is here. Drives prop density. */
  density: number;
};

export const STATIONS: Station[] = [
  {
    id: "origin",
    eyebrow: "How I started",
    title: "Building shit from scratch",
    meta: "high-frequency trading logs · the first thing I ever automated",
    body: [
      "I first started coding in high school, through the CS classes we had. At the time, I wasn't particularly enthusiastic. Our classes involved a lot of broad theory, spanning the history of computers to the societal implications of software.",
      "Algorithms were somewhat of a foreign concept. We were taught to memorize sorting technique code, but not how the code primitives themselves worked. We were never taught what a function was, or how you would create one.",
      "The summer right after grad, I was twiddling my fingers, so I decided to work for my relative, who was an independent high frequency trader. The work he gave me revolved around a lot of manual work with daily log files.",
      "The logs were huge — market data plus a bunch of execution flags, reject reasons, and other indicators. My job was to sift through that output, pull out the relevant events, and paste them into a spreadsheet so they could be reviewed.",
      "After doing this for weeks, I was getting tired. This felt like the most manual of labor. I knew this was a repetitive scanning task that I could offload to a program. Perhaps I could use whatever knowledge I had accumulated during high school.",
      "So I said fuck it. I learned Python, and automated the parsing, turning 30–60 minutes of repetitive work into scripts that ran in under a minute.",
    ],
    pull: "My first real act as an engineer was deleting my own job.",
    image: "/portfolio/logger.jpg",
    imageAlt: "The raw trading log — thousands of lines I sifted through by hand.",
    imageAfter: "/portfolio/logger-excel.webp",
    imageAfterAlt: "The clean spreadsheet the Python script pulls out of that log in under a minute.",
    color: "#F0A868",
    density: 1,
  },
  {
    id: "atlassian",
    eyebrow: "The day job",
    title: "Rovo, at Atlassian",
    meta: "P40, Central AI — growth & search · Jun 2024 → now",
    body: [
      "I work on Rovo across search, chat, and its Chrome extension — mostly on performance-sensitive, state-heavy user flows.",
      "I built and scaled the extension that surfaces AI chat and enterprise search, designed URL routing handling ten thousand daily requests across four teams' DNS migrations, and defined the growth team's experimentation infrastructure.",
    ],
    stats: [
      { value: "20K+", label: "downloads" },
      { value: "7K", label: "monthly actives" },
      { value: "+20.1%", label: "messages sent" },
    ],
    links: [
      { label: "Rovo", href: "https://www.atlassian.com/software/rovo" },
      {
        label: "The Chrome extension",
        href: "https://chromewebstore.google.com/detail/rovo-search-chat-and-more/npbjhobkibekbklkghlhfhieggcggpdb",
      },
    ],
    color: "#7BA8D9",
    density: 0.7,
  },
  {
    id: "kreatify",
    eyebrow: "The venture",
    title: "Kreatify",
    meta: "co-founder & CTO · Oct 2024 → Apr 2025 · alongside the full-time job",
    body: [
      "Built with influencer agency The Viralist Group to close a real gap in influencer marketing: campaigns ran with almost no transparency. Influencers had little visibility into the process, which meant delays, missed steps, and bad responsiveness.",
      "Kreatify is a multi-tenant platform where managers lay out and track campaigns, influencers watch their own progress and centralize deliverables, and brands see campaign status in real time. OAuth onboarding, role-based access control, file handling, and Phyllo integrations across YouTube, TikTok and Instagram.",
      "I ran the user interviews myself and rebuilt the UX around what came back.",
    ],
    stats: [
      { value: "7", label: "agencies" },
      { value: "30+", label: "in private beta" },
      { value: "716", label: "commits" },
    ],
    links: [
      { label: "kreatify.io", href: "https://kreatify.io" },
      { label: "The app", href: "https://app.kreatify.io" },
    ],
    image: "/portfolio/kreatify.jpg",
    imageAlt: "The Kreatify campaign workspace — deliverables, milestones and contracts for one partnership.",
    color: "#E8B45A",
    density: 0.48,
  },
  {
    id: "gooni",
    eyebrow: "The obsession",
    title: "Gooni",
    meta: "attempt four · 5 months, solo · the site you're standing in",
    body: [
      "Gooni wasn't the first attempt — it was the fourth. Before it came Lucid, then life_ai, then flow, each a different angle on the same itch: a system that actually understands the mess of your own life instead of making you file it. flow's final commit reads, in full: \"prob ass. im bailing on this one\".",
      "The fourth one stuck. I was working on chat interfaces at work and wanted to understand how they actually worked underneath, so I built one. It became an ambient assistant — every thought lands in one log, it notices the commitment-shaped ones, and surfaces what matters now.",
      "What it taught me wasn't how to add features. It was when to take them out.",
    ],
    beats: [
      { text: "A basic CLI" },
      { text: "Migrated to a UI" },
      { text: "A memory layer" },
      { text: "Entities that mapped to my actual life" },
      { text: "Got curious about evals, so I built my own eval system" },
      {
        text: "ReAct and Reflexion",
        cut: true,
        why: "ripped out — the score wasn't good enough to justify keeping it",
      },
      { text: "GitHub, LeetCode and Whoop pulled in; Telegram and WhatsApp as the way in" },
      {
        text: "Gooni's own intelligence layer",
        cut: true,
        why: "removed — too much friction, not enough value",
      },
      {
        text: "For a while I exposed MCP and let Claude do the thinking — Gooni was just persistence, display, and ingestion. Now I'm pulling the inference back in-house: Gooni does its own thinking again, leaner than the first time.",
      },
    ],
    pull: "I built the thing that told me to delete my own work, and then I listened.",
    // Every figure here is checkable against the repo. The earlier set
    // (831 commits / 190,101 written / "20→6 tables") did not survive
    // an audit: the commit count rots with every push, the insertion
    // total doesn't reproduce under --shortstat OR --numstat, and
    // "20→6" described the primitive layer, not the schema — there are
    // 25 tables today, so a reader with repo access would catch it.
    // PR #404 verifies at exactly +1,298 / -32,252 via `gh pr view`.
    stats: [
      { value: "22", label: "tables dropped, one PR" },
      { value: "−32,252", label: "lines, that same PR" },
      { value: "119k", label: "lines deleted overall" },
    ],
    links: [{ label: "Source", href: "https://github.com/gub1th/gooni" }],
    color: "#4ADE80",
    density: 0.18,
  },
  {
    id: "edge",
    eyebrow: "What I'm looking for",
    title: "Where the island runs out",
    body: [
      "I'm drawn to small, product-driven teams where engineers own problems end to end and grow alongside the system.",
      "I want to be challenged. I want something I can bet on and pour a lot of energy into. I want to work with cracked people, learn from them, and let that push me forward.",
    ],
    color: "#E88AA0",
    density: 0.02,
  },
];

/** Off-path scenery. Never labelled in-world — found, not presented. */
export const SCENERY = [
  // Ranking claim pulled: nothing public or on the resume backs it,
  // and an unbackable number on a portfolio is the one kind of error
  // that costs more than it gains.
  { id: "tennis", label: "Tennis, competitively for 10+ years" },
  { id: "hoop", label: "Basketball" },
  { id: "mic", label: "Freestyle rap" },
  { id: "lectern", label: "CS teaching assistant — 15+ cohorts at CMU" },
];
