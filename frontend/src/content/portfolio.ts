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
  // The current line + the longer story below are HIS verbatim prose (from
  // danis-website). Kept exactly, em dashes and all: it's his voice, not slop.
  now:
    "Currently working on Rovo across search, chat, and its Chrome extension — with a focus " +
    "on performance-sensitive, state-heavy user flows.",
  // "How I started" — the trading-log origin, in his words. One entry per paragraph.
  story: [
    "I started coding early, mostly by building small tools and games. What really pulled " +
      "me in was using code to deal with messy, real-world problems.",
    "A relative I worked with was in high-frequency trading and had a lot of manual work " +
      "around daily log files. The logs were huge — market data plus a bunch of execution " +
      "flags, reject reasons, and other indicators.",
    "My job was to sift through that output, pull out the relevant events, and paste them " +
      "into a spreadsheet so they could be reviewed. After a while I realized there was a " +
      "pattern, learned Python, and automated the parsing — turning 30–60 minutes of " +
      "repetitive work into scripts that ran in under a minute.",
  ] as string[],
  // "What I'm looking for" — his words, verbatim.
  looking: [
    "I'm drawn to small, product-driven teams where engineers own problems end to end and " +
      "grow alongside the system.",
    "I want to be challenged. I want something I can bet on and pour a lot of energy into. I " +
      "want to work with cracked people, learn from them, and let that push me forward.",
  ] as string[],
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
      "Gooni eats everything I think — web, Telegram, WhatsApp — into one append-only log. " +
      "Under it: a custom orchestrator, a memory system that extracts and reconciles what it " +
      "learns, and an eval harness I wrote to grade myself. Then I used those evals to gut what " +
      "wasn't pulling weight, including a whole ReAct/Reflexion layer that never beat the dumb " +
      "pipeline. One pass alone killed 22 tables and 32,252 lines the day the numbers stopped " +
      "backing them up. It's deployed. I use it every day.",
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
      "Zero to one as co-founder and CTO, nights and weekends around the full-time job. I built " +
      "the product on Next.js and Supabase — OAuth onboarding, role-based access, file handling, " +
      "Phyllo wired into YouTube, TikTok and Instagram, and a Notion-style filter engine I'm " +
      "still weirdly proud of. Ran the interviews myself, rebuilt the UX around what people " +
      "actually said, and shipped a private beta to 40+ users across seven agencies.",
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
      "Reads your raw journal entries and pulls out the people, goals and events buried in " +
      "them, then wires those into a life map you can actually navigate instead of a pile of " +
      "text you'll never reread.",
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
      "Started and now lead an AI platform service from scratch: a prompt template plus a user's hydrated data goes in, a served model response comes out, and offline evals with configurable LLM judges gate every deploy. I also own the frontend and nudge-scheduling for a personalized AI surface, down through the app and Redis caching layers.",
      "Built and scaled the Rovo Chrome extension (TypeScript, React) — AI chat and enterprise search a shortcut away — from 8K to 20K+ installs at ~7K monthly actives. The chat CTA I shipped pushed daily actives on it up 74.5%.",
      "Ran 15+ experiments across Rovo's biggest surfaces — Jira, Confluence, Townsquare — for a 45% lift in button usage and 20.1% in chat events. Set up a lot of how the team runs experiments now: custom metrics, standardized Statsig tagging.",
      "Ended up the de facto lead on 4 things at once — scoping them, sequencing them, working out how to test them across product, design and eng. 270 PRs and 500+ reviews across four repos, some Sev3 incident response, and one migration that cut ~$10k/month.",
      "Own the frontend for third-party connectors across every Atlassian surface. Built a generic config so a connector added on the backend needs zero bespoke frontend work, plus a portable settings package other teams (Confluence, Townsquare) now use — worth a 23.7% lift in third-party auth completions.",
    ],
  },
  {
    title: "Co-Founder & CTO",
    org: "Kreatify",
    location: "San Francisco, CA",
    period: "Oct 2024 – Apr 2025",
    points: [
      "Co-founded and built an influencer CRM for talent agencies on Next.js and Supabase — OAuth onboarding, role-based access, file handling, Phyllo wired into YouTube, TikTok and Instagram.",
      "Designed and built the UX solo, and owned a few core systems — including a Notion-style filter engine.",
      "Ran the interviews, iterated on what came back, and shipped a private beta to 40+ users across 7 agencies — all on nights and weekends around the full-time job.",
    ],
  },
  {
    title: "Software Engineer Intern, Halp (Atlassian Assist)",
    org: "Atlassian",
    location: "New York City, NY",
    period: "May – Aug 2023",
    points: [
      "Moved a Slack ticketing bot off legacy messaging onto Block Kit, so creating a ticket in-chat actually felt modern.",
    ],
  },
  {
    title: "CS Teaching Assistant",
    org: "Carnegie Mellon University",
    location: "Pittsburgh, PA",
    period: "Aug 2022 – May 2024",
    points: [
      "Ran recitations for 15+ cohorts on programming fundamentals — Python and database design.",
    ],
  },
  {
    title: "AI Research Intern",
    org: "Comcast Labs",
    location: "Philadelphia, PA",
    period: "May – Aug 2022",
    points: [
      "Prototyped a transformer-based headline classifier at 97% accuracy and got it running on embedded devices.",
      "Built D3.js views over Splunk data to make anomalies jump out.",
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
