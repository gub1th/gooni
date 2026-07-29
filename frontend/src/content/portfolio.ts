// THE portfolio content — single source of truth for both surfaces:
// the 3D plaza landmarks (/creative) and the flat text portfolio
// (/public/cv). Edit here, both update.
//
// Deliberately plain data, no JSX: the plaza renders it into 3D peek
// cards, the text page renders it into sections. Neither owns the copy.

export type Link = {
  label: string;
  href: string;
};

export type Stat = {
  value: string;
  label: string;
};

/** Weight decides the treatment on both surfaces.
 *  monument — full landmark + stats + essay-length blurb
 *  pylon    — real card, stack + links, no stats
 *  archive  — one line in a list; student-era work
 */
export type ProjectWeight = "monument" | "pylon" | "archive";

export type Project = {
  id: string;
  name: string;
  /** One line. Shows on the card and in the archive list. */
  tagline: string;
  /** Paragraph. Monuments + pylons only. */
  blurb?: string;
  /** Monuments only — the numbers that make the case. */
  stats?: Stat[];
  stack: string[];
  links?: Link[];
  weight: ProjectWeight;
  /** Accent hex — drives the 3D landmark colour + card trim. */
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
  role: "Software Engineer at Atlassian",
  location: "San Francisco, CA",
  // From danis-website — kept because it's his line, not a generated one.
  thesis: "I build thoughtful software where product, systems, and user experience meet.",
  // The origin story. Real, specific, and it predates every job here.
  origin:
    "I started by automating my own busywork — turning thirty to sixty minutes of " +
    "hand-processing trading logs into a Python script that finished in under a minute. " +
    "Everything since has been a version of that: notice the repetitive thing, then delete it.",
  now:
    "At Atlassian I work on Rovo — enterprise search and AI chat — mostly on " +
    "performance-sensitive, state-heavy user flows. Outside of it I'm building Gooni, " +
    "an ambient assistant that's taught me more about deleting code than writing it.",
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
      "Every thought — web, WhatsApp, Telegram — lands in one append-only log. Gooni notices " +
      "the commitment-shaped ones, surfaces what matters right now through deterministic " +
      "rankers, and builds a memory of how I think. I built a bespoke intelligence layer for " +
      "it, measured it with an eval harness, and then deleted the parts the numbers " +
      "condemned — dropping twenty-two tables in a single pull request. " +
      "The deleting turned out to be the skill worth showing.",
    // See the note in content/walk.ts — the previous figures didn't
    // reproduce and contradicted the ones published on the other page.
    // These are checkable: PR #404 is +1,298 / -32,252 and drops 22
    // tables; total deletions across main are ~119k.
    stats: [
      { value: "22", label: "tables dropped, one PR" },
      { value: "−32,252", label: "lines, that same PR" },
      { value: "119k", label: "lines deleted overall" },
      { value: "5 mo", label: "solo" },
    ],
    stack: ["FastAPI", "React", "TypeScript", "SQLite", "Fly.io", "MCP"],
    // Source link removed: the repo is private, so it 404'd for every
    // visitor. Restore it if gub1th/gooni goes public.
    links: [{ label: "You're standing in it", href: "/public" }],
    weight: "monument",
    color: "#4ADE80",
    period: "2026 — present",
  },
  {
    id: "kreatify",
    name: "Kreatify",
    tagline: "An influencer CRM for talent agencies. Co-founded it, built it, ran it.",
    blurb:
      "Zero to one as co-founder and CTO, while holding a full-time engineering job. " +
      "OAuth onboarding, role-based access control, file handling, and Phyllo integrations " +
      "across YouTube, TikTok and Instagram. I ran the user interviews myself, rebuilt the " +
      "UX around what they said, and took it to a private beta with thirty-plus users at " +
      "seven talent agencies.",
    stats: [
      { value: "7", label: "agencies" },
      { value: "30+", label: "beta users" },
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
    period: "2024 — 2025",
    image: "/portfolio/kreatify.jpg",
    imageAlt: "The Kreatify campaign workspace — deliverables, milestones and contracts for one influencer partnership.",
  },
  {
    id: "lucid",
    name: "Lucid",
    tagline: "Free-form journals into a knowledge graph of people, goals and events.",
    blurb:
      "A personal system that reads unstructured journal entries and pulls out the entities " +
      "underneath — who you mentioned, what you're chasing, what actually happened — then " +
      "wires them into a navigable life map instead of a pile of text.",
    stack: ["FastAPI", "PostgreSQL", "React", "OpenAI"],
    weight: "pylon",
    color: "#8FB3E0",
    period: "2024 — 2025",
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
    imageAlt: "Empyrean — the steampunk battle-royale arena.",
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
    imageAlt: "MAPP — browsing and sharing scenic places.",
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
    imageAlt: "Cubewalker — the endless runner mid-run.",
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
    title: "Software Engineer, P40 — Central AI (Rovo Growth & Search)",
    org: "Atlassian",
    location: "San Francisco, CA",
    period: "Jun 2024 — present",
    current: true,
    points: [
      "Built and scaled the Rovo Chrome extension surfacing AI chat and enterprise search — grew to 20,000+ downloads and 7,000 monthly active users.",
      "Shipped a chat experiment that drove a 20.1% lift in message-sent events.",
      "Designed URL routing handling 10,000+ daily requests, coordinating DNS migrations across four teams.",
      "Defined the growth team's experimentation infrastructure — custom metrics and Statsig tagging.",
      "Co-led end-to-end delivery of a third-party Bulk Connect feature, working around a blocked backend API with a frontend approach to hit the launch date.",
    ],
  },
  {
    title: "Co-Founder & CTO",
    org: "Kreatify",
    location: "San Francisco, CA",
    period: "Oct 2024 — Apr 2025",
    points: [
      "Co-founded and built an influencer CRM for talent agencies — OAuth onboarding, role-based access control, file handling, Phyllo integrations across YouTube, TikTok and Instagram.",
      "Ran user interviews, iterated the UX, and shipped a private beta to 30+ users across 7 talent agencies.",
      "Held concurrently with a full-time engineering role.",
    ],
  },
  {
    title: "Software Engineer Intern — Halp (Atlassian Assist)",
    org: "Atlassian",
    location: "New York City, NY",
    period: "May — Aug 2023",
    points: [
      "Migrated a Slack ticketing bot from legacy Slack messaging to Block Kit, modernizing the conversational ticket-creation flow.",
    ],
  },
  {
    title: "CS Teaching Assistant",
    org: "Carnegie Mellon University",
    location: "Pittsburgh, PA",
    period: "Aug 2022 — May 2024",
    points: [
      "Led recitations for 15+ cohorts on programming fundamentals in Python and database design.",
    ],
  },
  {
    title: "AI Research Intern",
    org: "Comcast Labs",
    location: "Philadelphia, PA",
    period: "May — Aug 2022",
    points: [
      "Prototyped a transformer-based headline classifier at 97% accuracy, deployed on embedded devices.",
      "Built D3.js visualizations over Splunk datasets to surface anomalies.",
    ],
  },
];

export const EDUCATION: Education[] = [
  {
    school: "Carnegie Mellon University",
    credential: "BS Information Systems, Minor in Computer Science",
    detail: "GPA 3.76 · Dean's List",
    period: "2020 — 2024",
  },
];

// ── skills ──────────────────────────────────────────────────────────

export const SKILLS: { group: string; items: string[] }[] = [
  {
    group: "Languages",
    items: ["TypeScript", "JavaScript", "Python", "C", "SQL", "Java", "R", "Ruby", "C#", "Swift"],
  },
  {
    group: "Frameworks & tools",
    items: [
      "React", "Next.js", "Node", "Express", "FastAPI",
      "Supabase", "PostgreSQL", "SQLite", "Docker", "Git", "Three.js",
    ],
  },
];
