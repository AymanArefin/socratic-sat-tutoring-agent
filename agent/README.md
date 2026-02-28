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
- **Real SAT questions** — pulls live questions from the College Board Question Bank API across all 8 domains
- **Student profile tracking** — tracks accuracy per domain, identifies weak areas (< 60%), persists across sessions
- **Performance dashboard** — domain-by-domain breakdown, difficulty breakdown, and last 10 question history
- **Adaptive difficulty** — prioritizes weak domains and adjusts question selection based on performance
- **Answer security** — correct answers are stored server-side only in SQLite, never transmitted to the client
- **Real-time streaming** — WebSocket-based chat with streaming AI responses
- **Persistent state** — student history stored in Durable Objects + SQLite; survives disconnects and agent hibernation

---

## SAT Domains Covered

| Section | Domains |
|---|---|
| Reading & Writing | Standard English Conventions, Expression of Ideas, Information and Ideas, Craft and Structure |
| Math | Algebra, Advanced Math, Problem-Solving and Data Analysis, Geometry and Trigonometry |

---

## Agent Tools

The agent has four tools. A critical guard (`selectActiveTools`) runs on every message and only exposes the tool that matches the student's explicit intent — preventing the model from firing tools on short, vague, or conversational messages like "ok", "why", or "what?".

---

### `fetchSATQuestion`

Fetches a real multiple-choice SAT practice question from the College Board Question Bank API.

**Triggered when:** the student explicitly asks for a practice question, quiz, or exercise.
> "Give me a hard algebra question", "Quiz me on grammar", "I want to practice reading"

**Inputs:**
| Parameter | Type | Description |
|---|---|---|
| `domain` | string | SAT domain — e.g. `"algebra"`, `"grammar"`, `"Standard English Conventions"` |
| `difficulty` | string | `"easy"`, `"medium"`, or `"hard"` |

**What it does internally:**
1. Calls the College Board API (`get-questions`) to retrieve the question list for the requested domain
2. Filters out entries missing an `external_id` — up to 38% of math domain entries lack one and cause API errors
3. Filters to the requested difficulty; falls back to any valid question if no match exists
4. Shuffles the pool and retries up to 5 times to skip Student-Produced Response (grid-in) questions that have no answer choices
5. Fetches full question detail (`get-question`) including stem, optional passage stimulus, and answer options
6. Strips all HTML tags and decodes HTML entities (the College Board API returns names like `Chraïbi` as `Chra&iuml;bi`)
7. **Stores the correct answer and explanation in SQLite server-side only** — never included in the response to the client
8. Returns the question stem, optional stimulus passage, A/B/C/D choices, domain, and difficulty — with no answer or explanation

**Returns:**
```json
{
  "questionId": "cb-external-id",
  "domain": "Algebra",
  "difficulty": "M",
  "stem": "Which expression is equivalent to...",
  "stimulus": null,
  "choices": { "A": "2x + 1", "B": "3x - 2", "C": "x²", "D": "4x" },
  "choiceCount": 4
}
```

---

### `recordAnswer`

Records the student's selected answer and scores it against the correct answer stored in SQLite.

**Triggered when:** the student's message contains the literal text `ANSWER:`.
> The UI sends answers as `ANSWER: B | questionId: abc123` when the student clicks a choice button.

**Inputs:**
| Parameter | Type | Description |
|---|---|---|
| `questionId` | string | The ID returned by `fetchSATQuestion` |
| `selectedAnswer` | string | The letter the student chose: `A`, `B`, `C`, or `D` |

**What it does internally:**
1. Looks up the correct answer from `pending_questions` in SQLite (the source of truth — not from Agent state, to avoid race conditions on state hydration)
2. Compares the selected answer to the correct answer
3. Updates `question_history` in SQLite with the result
4. Updates the student's `StudentProfile` state: `totalAnswered`, `totalCorrect`, and `domainStats` per domain
5. Recomputes `weaknesses` (domains with ≥ 3 attempts and < 60% accuracy) and syncs the updated profile to all connected clients via `this.setState()`

**Returns:**
```json
{
  "correct": false,
  "selectedAnswer": "B",
  "correctAnswer": "C",
  "domain": "Algebra",
  "difficulty": "M",
  "explanation": "The correct approach is to factor the expression..."
}
```

The agent then uses the result Socratically — wrong answers trigger probing questions rather than direct correction.

---

### `getDashboard`

Returns the student's full performance breakdown, queried live from SQLite.

**Triggered when:** the student asks for their progress, stats, scores, or history — or sends `DASHBOARD: show`.
> "How am I doing?", "Show me my stats", "What are my weak areas?"

**Inputs:** none

**What it returns:**

| Field | Description |
|---|---|
| `overallAccuracy` | Percentage correct across all questions answered |
| `totalAnswered` / `totalCorrect` | Raw counts |
| `weaknesses` | Array of domain names with < 60% accuracy (min 3 attempts) |
| `domainBreakdown` | Per-domain total, correct, and accuracy % |
| `difficultyBreakdown` | Easy / Medium / Hard totals and accuracy % |
| `recentHistory` | Last 10 questions: domain, difficulty, correct/incorrect, timestamp |

---

### `explainStrategy`

Returns targeted SAT study strategies for a specific domain or the student's current weakest area.

**Triggered when:** the student explicitly asks for strategies, tips, or how to improve.
> "Any tips for Standard English Conventions?", "How do I get better at algebra?", "What should I study?"

**Inputs:**
| Parameter | Type | Description |
|---|---|---|
| `domain` | string (optional) | Domain to get strategies for. Omit to auto-select the student's weakest area. |

**Built-in strategies per domain** (5–6 actionable tips each):

| Domain | Example strategy |
|---|---|
| Standard English Conventions | "Commas before coordinating conjunctions (FANBOYS) join two independent clauses." |
| Expression of Ideas | "Transition questions: choose words that match the logical relationship (contrast, cause-effect, addition)." |
| Information and Ideas | "Paired questions: find the answer first, then select the best evidence." |
| Craft and Structure | "Vocabulary in context: substitute your own word before looking at choices." |
| Algebra | "Check your answer by substituting back into the original equation." |
| Advanced Math | "f(x+2) means substitute (x+2) everywhere you see x." |
| Problem-Solving and Data Analysis | "Mean is pulled toward outliers; median is more robust." |
| Geometry and Trigonometry | "SOHCAHTOA: sin = opp/hyp, cos = adj/hyp, tan = opp/adj." |

**Returns:** domain name, current accuracy in that domain, whether it's a weak area, the strategy list, and a personalized tip (e.g. "You're at 45% in Algebra. Practice 3-5 questions daily in this area.").

The agent delivers all strategies in Socratic form — following up with questions that ask the student to apply the tip rather than just reading it.

---

## Intent Guard: `selectActiveTools`

All four tools are gated by an intent classifier that runs before every AI call. It pattern-matches the student's message using regex and only exposes the relevant tool (or no tools at all for conversational messages).

| Pattern matched | Tool exposed |
|---|---|
| `ANSWER:` present anywhere in the message | `recordAnswer` only |
| "my progress", "my stats", "my score", "history", "dashboard" | `getDashboard` only |
| "give me", "quiz me", "practice", "a question", "test me", "exercise" | `fetchSATQuestion` only |
| "strategy", "tips", "how do I improve", "study plan", "help me on" | `explainStrategy` only |
| Everything else (short messages, conversational, vague) | No tools — text response only |

This prevents the model from hallucinating tool calls on messages like "ok", "thanks", "why", or "what?".

---

## Project Structure

```
agent/
  src/
    server.ts   # ChatAgent: system prompt, all four tools, intent guard, student state
    app.tsx     # React chat UI (Kumo design system + answer choice buttons)
    client.tsx  # React entry point
    styles.css  # Tailwind + Kumo styles
  tests/
    helpers.test.mjs  # Unit tests for pure helpers (run: node tests/helpers.test.mjs)
  wrangler.jsonc      # Cloudflare Workers configuration
  package.json
```

---

## Running Locally

```bash
cd agent
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Try these prompts:
- `"Give me a hard algebra question"` — fetches a practice problem
- `"Quiz me on Standard English Conventions"` — Reading & Writing question
- `"I don't understand"` — triggers Socratic clarifying questions
- `"How is my progress?"` — renders the performance dashboard
- `"Any tips for geometry?"` — domain-specific strategies

Run the unit tests:
```bash
node tests/helpers.test.mjs
```

---

## Deployment

```bash
npm run deploy
```

Builds with Vite and deploys to Cloudflare's global network. The Worker URL is `socratic-sat-tutoring-agent.<your-subdomain>.workers.dev`.

---

## Architecture

```
Browser (React SPA)
    │  WebSocket / HTTP
    ▼
Cloudflare Worker (static asset serving + routing)
    │
    ▼
ChatAgent (Durable Object — one per student session)
    ├── SQLite: question_history, pending_questions
    ├── Agent state: StudentProfile (accuracy, domainStats, weaknesses)
    ├── Workers AI: llama-3.3-70b-instruct via AI binding
    └── College Board Question Bank API
```

`ChatAgent` extends `AIChatAgent` from `@cloudflare/ai-chat`. The Socratic system prompt is rebuilt on every request from the live `StudentProfile` so the model always has current accuracy and weakness data in context. Correct answers are stored only in SQLite and never returned to the client.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers |
| Agent framework | Agents SDK (`agents`, `@cloudflare/ai-chat`) |
| AI model | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI |
| Streaming | Vercel AI SDK (`ai`) |
| State / persistence | Durable Objects + SQLite |
| Frontend | React 19, Tailwind CSS, Kumo design system |
| Build | Vite + `@cloudflare/vite-plugin` |

---

## License

MIT
