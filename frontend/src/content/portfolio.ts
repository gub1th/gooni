// THE portfolio content: single source of truth for both surfaces,
// the 3D plaza landmarks (/creative) and the flat text portfolio
// (/public/cv). Edit here, both update.
//
// Deliberately plain data, no JSX: the plaza renders it into 3D peek
// cards, the text page renders it into sections. Neither owns the copy.
//
// No em dashes in any rendered string (Daniel's call); date ranges use an
// en dash, prose uses commas/colons/parens.

export type Link = {
  label: string;
  href: string;
};

export type Stat = {
  value: string;
  label: string;
};

/** Weight decides the treatment on both surfaces.
 *  monument: full landmark + stats + essay-length blurb
 *  pylon:    real card, stack + links, no stats
 *  archive:  one line in a list; student-era work
 */
export type ProjectWeight = "monument" | "pylon" | "archive";

export type Project = {
  id: string;
  name: string;
  /** One line. Shows on the card and in the archive list. */
  tagline: string;
  /** Paragraph. Monuments + pylons only. */
  blurb?: string;
  /** Monuments only: the numbers that make the case. */
  stats?: Stat[];
  stack: string[];
  links?: Link[];
  weight: ProjectWeight;
  /** Accent hex: drives the 3D landmark colour + card trim. */
  color: string;
  /** Years active, shown as metadata. */
  period?: string;
  /** Screenshot under /public/portfolio. Doubles as the card hero and
   *  the texture on the landmark's floating billboard, so it wants a
   *  landscape crop that survives being shrunk to ~200px wide. */
  image?: string;
  imageAlt?: string;
};

export type Role = {
  title: string;
  org: string;
  location: string;
  period: string;
  /** Bullets, strongest first. */
  points: string[];
  /** Set on the one role that's current. */
  current?: boolean;
};

export type Education = {
  school: string;
  credential: string;
  detail?: string;
  period: string;
};

// ── identity ────────────────────────────────────────────────────────

export const PROFILE = {
  name: "Daniel Gunawan",
  role: "Software Engineer II at Atlassian",
  location: "San Francisco, CA",
  // His line, not a generated one.
  thesis: "I build thoughtful software where product, systems, and user experience meet.",
  // The origin story. Real, specific, and it predates every job here.
  origin:
    "My first real program automated my own busywork. I was spending thirty to sixty " +
    "minutes a day hand-processing trading logs, so I wrote a Python script that did it in " +
    "under a minute. Most of what I've built since has started the same way: I notice " +
    "something repetitive, then I get rid of it.",
  now:
    "At Atlassian I work on Rovo, the enterprise search and AI chat product. Lately I " +
    "started an AI platform service there from scratch, and I own a handful of the growth " +
    "and third-party connector surfaces. On the side I'm building Gooni, an ambient " +
    "assistant that has taught me more about deleting code than writing it.",
  links: [
    { label: "Email", href: "mailto:danielfgunawan1@gmail.com" },
    { label: "LinkedIn", href: "https://www.linkedin.com/in/danielfgunawan/" },
    { label: "GitHub", href: "https://github.com/gub1th" },
  ] as Link[],
  resumeHref: "/DANIEL_RESUME.pdf",
} as const;

// ── projects ────────────────────────────────────────────────────────

export const PROJECTS: Project[] = [
  {
    id: "gooni",
    name: "Gooni",
    tagline: "A personal AI notebook that became an ambient assistant.",
    blurb:
      "Gooni captures everything I think, from web, Telegram and WhatsApp, into one " +
      "append-only log. I built it around a custom orchestrator, a persistent memory system " +
      "that extracts and reconciles what it learns, and an evaluation harness I wrote myself. " +
      "Then I used those evals to cut what didn't earn its place, including a ReAct/Reflexion " +
      "layer that never beat the simpler pipeline. One pass dropped twenty-two tables and " +
      "32,252 lines once the numbers stopped justifying them. It's deployed and I use it " +
      "every day.",
    // Checkable: PR #404 is +1,298 / -32,252 and drops 22 tables; total
    // deletions across main are ~119k.
    stats: [
      { value: "22", label: "tables dropped, one PR" },
      { value: "−32,252", label: "lines, that same PR" },
      { value: "119k", label: "lines deleted overall" },
      { value: "5 mo", label: "solo" },
    ],
    stack: ["FastAPI", "React", "TypeScript", "SQLite", "Fly.io", "MCP"],
    links: [
      { label: "Source", href: "https://github.com/gub1th/gooni" },
      { label: "You're standing in it", href: "/public" },
    ],
    weight: "monument",
    color: "#4ADE80",
    period: "2026 – present",
  },
  {
    id: "kreatify",
    name: "Kreatify",
    tagline: "An influencer CRM for talent agencies. Co-founded it, built it, ran it.",
    blurb:
      "Zero to one as co-founder and CTO, while holding a full-time engineering job. I built " +
      "the product on Next.js and Supabase: OAuth onboarding, role-based access control, file " +
      "handling, Phyllo integrations across YouTube, TikTok and Instagram, and a Notion-style " +
      "generic filtering engine. I ran the user interviews myself, iterated the UX around what " +
      "they said, and took it to a private beta with 40+ users across seven talent agencies.",
    stats: [
      { value: "7", label: "agencies" },
      { value: "40+", label: "beta users" },
      { value: "716", label: "commits" },
      { value: "0→1", label: "as CTO" },
    ],
    stack: ["Next.js", "Supabase", "TypeScript", "Phyllo API"],
    links: [
      { label: "kreatify.io", href: "https://kreatify.io" },
      { label: "The app", href: "https://app.kreatify.io" },
    ],
    weight: "monument",
    color: "#F0A868",
    period: "2024 – 2025",
    image: "/portfolio/kreatify.jpg",
    imageAlt: "The Kreatify campaign workspace: deliverables, milestones and contracts for one influencer partnership.",
  },
  {
    id: "lucid",
    name: "Lucid",
    tagline: "Free-form journals into a knowledge graph of people, goals and events.",
    blurb:
      "A personal system that reads unstructured journal entries and pulls out the entities " +
      "underneath (who you mentioned, what you're chasing, what actually happened), then " +
      "wires them into a navigable life map instead of a pile of text.",
    stack: ["FastAPI", "PostgreSQL", "React", "OpenAI"],
    weight: "pylon",
    color: "#8FB3E0",
    // Ordering confirmed against commit history: Lucid came first
    // (585 commits in 2024), before life_ai and flow.
    period: "2024 – 2025",
    image: "/portfolio/lucid.jpg",
    imageAlt: "Lucid turning journal entries into a navigable graph of people, goals and events.",
  },
  {
    id: "empyrean",
    name: "Empyrean",
    tagline: "A 3D FPS battle royale with a steampunk theme, built with the Game Creation Society.",
    stack: ["C#", "Unity"],
    links: [{ label: "Play it", href: "https://www.gamecreation.org/games/empyrean" }],
    weight: "archive",
    color: "#B79BE0",
    period: "CMU",
    image: "/portfolio/empyrean.jpg",
    imageAlt: "Empyrean: the steampunk battle-royale arena.",
  },
  {
    id: "housemates",
    name: "Housemates",
    tagline: "A Swift app for shared-home organization and chores.",
    stack: ["Swift", "Firebase"],
    links: [
      { label: "Demo", href: "https://www.youtube.com/watch?v=JWnoy6bBSOo" },
      { label: "Source", href: "https://github.com/Housemates-Mobile-App/housemates_mobileapp" },
    ],
    weight: "archive",
    color: "#7EC8E3",
    period: "CMU",
  },
  {
    id: "mapp",
    name: "MAPP",
    tagline: "Full-stack app for finding and sharing scenic places.",
    stack: ["Django", "JavaScript"],
    links: [{ label: "Source", href: "https://github.com/gub1th/mapp" }],
    weight: "archive",
    color: "#84CC8B",
    period: "CMU",
    image: "/portfolio/mapp.jpg",
    imageAlt: "MAPP: browsing and sharing scenic places.",
  },
  {
    id: "cubewalker",
    name: "Cubewalker",
    tagline: "An endless runner with 3D graphics, simulated physics and simple AI.",
    stack: ["Python"],
    links: [{ label: "Source", href: "https://github.com/gub1th/cubeWalker" }],
    weight: "archive",
    color: "#E8B45A",
    period: "CMU",
    image: "/portfolio/cubewalker.jpg",
    imageAlt: "Cubewalker: the endless runner mid-run.",
  },
  {
    id: "pong-league",
    name: "Brotherhood Pong League",
    tagline: "A site to organize and track an interfraternal pong league.",
    stack: ["PostgreSQL", "Express", "React", "Node"],
    links: [{ label: "Source", href: "https://github.com/gub1th/bplPERN" }],
    weight: "archive",
    color: "#E88A8A",
    period: "CMU",
    image: "/portfolio/pong-league.jpg",
    imageAlt: "The Brotherhood Pong League standings table.",
  },
];

export const MONUMENTS = PROJECTS.filter((p) => p.weight === "monument");
export const PYLONS = PROJECTS.filter((p) => p.weight === "pylon");
export const ARCHIVE = PROJECTS.filter((p) => p.weight === "archive");

// ── experience ──────────────────────────────────────────────────────

export const ROLES: Role[] = [
  {
    title: "Software Engineer II, Central AI (Rovo Growth & Search)",
    org: "Atlassian",
    location: "San Francisco, CA (Remote)",
    period: "Jun 2024 – present",
    current: true,
    points: [
      "Started and lead a from-scratch AI platform service that turns a prompt template plus hydrated user data into a served model response, with offline evaluation and configurable LLM judges gating every deploy. Also own the frontend and nudge-scheduling system for a personalized AI surface, across the application and Redis caching layers.",
      "Built and scaled the Rovo Chrome extension (TypeScript, React) surfacing AI chat and enterprise search, growing it from 8K to 20K+ installs at ~7K monthly actives. Shipped the chat CTA that drove a 74.5% lift in extension DAU.",
      "Shipped 15+ experiments across Rovo's most prominent surfaces (Jira, Confluence, Townsquare), driving a 45% lift in Rovo button usage and 20.1% in chat usage events. Helped define the team's experimentation infrastructure with custom metrics and standardized Statsig tagging.",
      "De facto feature lead on 4 concurrent initiatives, owning scoping, sequencing and experiment strategy across product, design and engineering. 270 PRs and 500+ code reviews across four repositories, plus cross-team Sev3 incident response and a migration that removed ~$10k/month in cost.",
      "Own the frontend for third-party connectors across every Atlassian surface. Built a generic 3P frontend config so a connector added on the backend needs no bespoke frontend work, and shipped a portable connector-settings package now used by other teams including Confluence and Townsquare, driving a 23.7% lift in third-party auth completions.",
    ],
  },
  {
    title: "Co-Founder & CTO",
    org: "Kreatify",
    location: "San Francisco, CA",
    period: "Oct 2024 – Apr 2025",
    points: [
      "Co-founded and built an influencer CRM for talent agencies (Next.js, Supabase): OAuth onboarding, role-based access control, file handling, and Phyllo integrations across YouTube, TikTok and Instagram.",
      "Independently designed and built the UX and owned several core systems, including a Notion-style generic filtering engine.",
      "Ran user interviews, iterated the product, and shipped a private beta to 40+ users across 7 talent agencies, all while holding a full-time engineering role.",
    ],
  },
  {
    title: "Software Engineer Intern, Halp (Atlassian Assist)",
    org: "Atlassian",
    location: "New York City, NY",
    period: "May – Aug 2023",
    points: [
      "Migrated a Slack ticketing bot from legacy Slack messaging to Block Kit, modernizing the conversational ticket-creation flow.",
    ],
  },
  {
    title: "CS Teaching Assistant",
    org: "Carnegie Mellon University",
    location: "Pittsburgh, PA",
    period: "Aug 2022 – May 2024",
    points: [
      "Led recitations for 15+ cohorts on programming fundamentals in Python and database design.",
    ],
  },
  {
    title: "AI Research Intern",
    org: "Comcast Labs",
    location: "Philadelphia, PA",
    period: "May – Aug 2022",
    points: [
      "Prototyped a transformer-based headline classifier at 97% accuracy, deployed on embedded devices.",
      "Built D3.js visualizations over Splunk datasets to surface anomalies.",
    ],
  },
];

export const EDUCATION: Education[] = [
  {
    school: "Carnegie Mellon University",
    credential: "Bachelor of Science in Information Systems, Minor in Computer Science",
    detail: "GPA 3.76 · Dean's List",
    period: "2020 – 2024",
  },
];

// ── skills ──────────────────────────────────────────────────────────

export const SKILLS: { group: string; items: string[] }[] = [
  {
    group: "Languages",
    items: ["TypeScript", "JavaScript", "Python", "C", "SQL", "Java", "HTML/CSS"],
  },
  {
    group: "AI",
    items: [
      "OpenAI API", "Model Context Protocol (MCP)", "Embeddings & vector retrieval",
      "LLM evaluation & judges", "Prompt engineering", "TensorFlow/Keras",
    ],
  },
  {
    group: "Frameworks & tools",
    items: [
      "React", "Next.js", "Node", "Express", "FastAPI",
      "Supabase", "PostgreSQL", "Redis", "Docker", "Git", "Statsig",
    ],
  },
];
