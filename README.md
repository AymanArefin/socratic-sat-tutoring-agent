# Socratic SAT Tutoring Agent

A Socratic AI tutor for SAT preparation, deployed on Cloudflare Workers.

**Live:** https://socratic-sat-tutoring-agent.aymanarefin21.workers.dev

---

## Repository Structure

```
agent/          # Cloudflare Worker — all deployable code lives here
  src/
    server.ts   # ChatAgent: Socratic system prompt, tools, student state
    app.tsx     # React chat UI (Kumo design system)
    client.tsx  # React entry point
    styles.css  # Tailwind + Kumo styles
  tests/
    helpers.test.mjs  # Unit tests for pure helpers (run: node tests/helpers.test.mjs)
  wrangler.jsonc      # Cloudflare Workers config
  package.json

research/       # Background research — not part of the deployed app
  API_INVESTIGATION_README.md  # College Board API investigation notes
  investigate_sat_api.py       # API exploration script
  requirements_investigation.txt
```

---

## What It Does

Instead of explaining or correcting directly, the agent guides students to discover answers through targeted questions. Wrong answers trigger probing questions that expose the reasoning gap. Right answers trigger reflection ("Why does that work?"). Hints are offered as questions, not statements.

Covers all 8 SAT domains across Reading & Writing and Math. Tracks per-domain accuracy, identifies weak areas, and persists student history across sessions using Durable Objects + SQLite.

---

## Getting Started

```bash
cd agent
npm install
npm run dev          # local dev at http://localhost:5173
npm run deploy       # deploy to Cloudflare
node tests/helpers.test.mjs   # run unit tests
```

See [`agent/README.md`](agent/README.md) for full documentation.

---

## Tech Stack

Cloudflare Workers · Agents SDK · Workers AI · Durable Objects · React 19 · Vite

---

## License

MIT
