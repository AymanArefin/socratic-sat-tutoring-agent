# Socratic SAT Tutoring Agent

A Socratic AI tutor for SAT preparation, built on [Cloudflare Workers](https://developers.cloudflare.com/workers/) using the [Agents SDK](https://developers.cloudflare.com/agents/).

**Live:** https://socratic-sat-tutoring-agent.aymanarefin21.workers.dev

---

## What is Socratic tutoring?

Instead of explaining concepts or correcting mistakes directly, this agent guides students to discover answers themselves through targeted questioning. The core principle: a student who reaches an answer through their own reasoning retains it far longer than one who is simply told.

Every wrong answer triggers a question that exposes the reasoning gap. Every right answer triggers a reflection question ("Why does that work?"). Hints are offered as questions, not statements.

---

## Features

- **Socratic dialogue** — question-first responses, correction via probing, hints as questions, metacognitive reflection after correct answers
- **SAT practice questions** — pulls real questions across all 8 SAT domains (Reading & Writing + Math) from the College Board API
- **Student profile tracking** — tracks accuracy per domain, identifies weak areas (< 60%), persists across sessions
- **Performance dashboard** — shows domain-by-domain breakdown, overall accuracy, and session history
- **Adaptive difficulty** — prioritizes weak domains and adjusts question selection based on performance
- **Real-time streaming** — WebSocket-based chat with streaming AI responses
- **Persistent state** — student history stored in SQLite via Durable Objects; survives disconnects and agent hibernation

---

## SAT Domains Covered

| Section | Domains |
|---|---|
| Reading & Writing | Standard English Conventions, Expression of Ideas, Information and Ideas, Craft and Structure |
| Math | Algebra, Advanced Math, Problem-Solving and Data Analysis, Geometry and Trigonometry |

---

## Project Structure

```
agent/
  src/
    server.ts   # Cloudflare Worker + ChatAgent (Socratic system prompt, tools, state)
    app.tsx     # Chat UI (React + Kumo components)
    client.tsx  # React entry point
    styles.css  # Tailwind + Kumo styles
  tests/
    helpers.test.mjs  # Unit tests for pure helper functions
  wrangler.jsonc      # Cloudflare Workers configuration
  package.json
```

---

## Tools Available to the Agent

| Tool | Trigger | Description |
|---|---|---|
| `fetchSATQuestion` | Student asks for a practice question | Fetches a real SAT question from the College Board API |
| `recordAnswer` | Message contains `ANSWER: <choice>` | Records the student's answer and updates domain stats |
| `getDashboard` | Student asks for progress / stats | Returns full performance breakdown by domain |
| `explainStrategy` | Student explicitly asks for a strategy | Provides study strategies (delivered Socratically) |

---

## Running Locally

```bash
cd agent
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Try asking:
- "Give me an algebra question" — fetches a practice problem
- "Quiz me on grammar" — fetches a Reading & Writing question
- "Show me my progress" — renders the performance dashboard
- "I don't understand why that's wrong" — triggers Socratic probing

---

## Deployment

```bash
npm run deploy
```

Deploys to Cloudflare's global network. The Worker URL is `socratic-sat-tutoring-agent.<your-subdomain>.workers.dev`.

---

## Architecture

```
Browser (React SPA)
    │  WebSocket / HTTP
    ▼
Cloudflare Worker (static asset serving + routing)
    │
    ▼
ChatAgent (Durable Object)
    ├── SQLite (question_history, pending_questions)
    ├── Agent state (StudentProfile — accuracy, domain stats, weaknesses)
    ├── Workers AI (inference via AI binding)
    └── College Board API (SAT question fetching)
```

The `ChatAgent` extends `AIChatAgent` from `@cloudflare/ai-chat`. It holds all student state in a `StudentProfile` struct that syncs to the React client in real time via `this.setState()`. The Socratic system prompt is rebuilt on every request from the live student profile so the model always has current accuracy and weakness data in context.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers |
| Agent framework | Agents SDK (`agents`, `@cloudflare/ai-chat`) |
| AI inference | Workers AI (`workers-ai-provider`) |
| Streaming | Vercel AI SDK (`ai`) |
| State / persistence | Durable Objects + SQLite |
| Frontend | React 19, Tailwind CSS, Kumo design system |
| Build | Vite + `@cloudflare/vite-plugin` |

---

## License

MIT
