import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, type Schedule, callable } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
  wrapLanguageModel,
  type StreamTextOnFinishCallback,
  type ToolSet,
  type LanguageModelMiddleware
} from "ai";
import { z } from "zod";

// ── Pure helpers ──────────────────────────────────────────────────────

/**
 * Decode named HTML entities and numeric character references.
 * Handles common accented characters the College Board API returns unescaped.
 */
function decodeHtmlEntities(str: string): string {
  const named: Record<string, string> = {
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&ldquo;": "\u201C",
    "&rdquo;": "\u201D",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
    "&mdash;": "\u2014",
    "&ndash;": "\u2013",
    "&hellip;": "\u2026",
    "&laquo;": "\u00AB",
    "&raquo;": "\u00BB",
    "&copy;": "\u00A9",
    "&reg;": "\u00AE",
    "&trade;": "\u2122",
    "&deg;": "\u00B0",
    "&plusmn;": "\u00B1",
    "&times;": "\u00D7",
    "&divide;": "\u00F7",
    "&frac12;": "\u00BD",
    "&frac14;": "\u00BC",
    "&frac34;": "\u00BE",
    // Latin extended-A / extended-B common in names
    "&agrave;": "\u00E0",
    "&aacute;": "\u00E1",
    "&acirc;": "\u00E2",
    "&atilde;": "\u00E3",
    "&auml;": "\u00E4",
    "&aring;": "\u00E5",
    "&aelig;": "\u00E6",
    "&ccedil;": "\u00E7",
    "&egrave;": "\u00E8",
    "&eacute;": "\u00E9",
    "&ecirc;": "\u00EA",
    "&euml;": "\u00EB",
    "&igrave;": "\u00EC",
    "&iacute;": "\u00ED",
    "&icirc;": "\u00EE",
    "&iuml;": "\u00EF",
    "&eth;": "\u00F0",
    "&ntilde;": "\u00F1",
    "&ograve;": "\u00F2",
    "&oacute;": "\u00F3",
    "&ocirc;": "\u00F4",
    "&otilde;": "\u00F5",
    "&ouml;": "\u00F6",
    "&oslash;": "\u00F8",
    "&ugrave;": "\u00F9",
    "&uacute;": "\u00FA",
    "&ucirc;": "\u00FB",
    "&uuml;": "\u00FC",
    "&yacute;": "\u00FD",
    "&thorn;": "\u00FE",
    "&yuml;": "\u00FF",
    // Uppercase variants
    "&Agrave;": "\u00C0",
    "&Aacute;": "\u00C1",
    "&Acirc;": "\u00C2",
    "&Atilde;": "\u00C3",
    "&Auml;": "\u00C4",
    "&Aring;": "\u00C5",
    "&AElig;": "\u00C6",
    "&Ccedil;": "\u00C7",
    "&Egrave;": "\u00C8",
    "&Eacute;": "\u00C9",
    "&Ecirc;": "\u00CA",
    "&Euml;": "\u00CB",
    "&Igrave;": "\u00CC",
    "&Iacute;": "\u00CD",
    "&Icirc;": "\u00CE",
    "&Iuml;": "\u00CF",
    "&Ntilde;": "\u00D1",
    "&Ograve;": "\u00D2",
    "&Oacute;": "\u00D3",
    "&Ocirc;": "\u00D4",
    "&Otilde;": "\u00D5",
    "&Ouml;": "\u00D6",
    "&Oslash;": "\u00D8",
    "&Ugrave;": "\u00D9",
    "&Uacute;": "\u00DA",
    "&Ucirc;": "\u00DB",
    "&Uuml;": "\u00DC",
    "&Yacute;": "\u00DD"
  };
  return str
    .replace(/&[a-zA-Z]+;/g, (m) => named[m] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

/**
 * Extract the first valid JSON object from a string, ignoring any trailing
 * characters. This handles LLMs that emit tool-call JSON followed by
 * artifacts like "__" or other tokens.
 */
function extractLeadingJSON(str: string): Record<string, unknown> | null {
  if (!str.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(str.slice(0, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── Tool-call text interceptor middleware ─────────────────────────────
// Some Workers AI models (including @cf/meta/llama-3.3-70b-instruct-fp8-fast)
// correctly return tool_calls in non-streaming mode, but in STREAMING mode
// they output the tool call as a text chunk like:
//   {"type":"function","name":"fetchSATQuestion","parameters":{...}}
// This middleware buffers all text output and converts that pattern to a
// proper tool-call event so the AI SDK can execute the tool automatically.
const toolCallTextInterceptor: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();

    let textBuffer = "";
    let textStartId: string | null = null;
    let hasEmittedToolCall = false;

    const transform = new TransformStream<
      Parameters<TransformStreamDefaultController["enqueue"]>[0],
      Parameters<TransformStreamDefaultController["enqueue"]>[0]
    >({
      transform(chunk: Record<string, unknown>, controller) {
        // Pass through non-text events immediately
        if (
          chunk.type !== "text-start" &&
          chunk.type !== "text-delta" &&
          chunk.type !== "text-end"
        ) {
          // Adjust finish reason when we converted text to a tool call
          if (chunk.type === "finish" && hasEmittedToolCall) {
            controller.enqueue({
              ...chunk,
              finishReason: { unified: "tool-calls", raw: "tool_calls" }
            });
          } else {
            controller.enqueue(chunk);
          }
          return;
        }

        if (chunk.type === "text-start") {
          textStartId = chunk.id as string;
          return; // buffer, don't emit yet
        }

        if (chunk.type === "text-delta") {
          textBuffer += chunk.delta as string;
          return; // buffer, don't emit yet
        }

        if (chunk.type === "text-end") {
          const trimmed = textBuffer.trim();

          // Try to detect a text-encoded tool call JSON.
          // GLM and Llama models output: {"type":"function","name":"...","parameters":{...}}
          // Some models append trailing tokens (e.g. "__") after the JSON, so we
          // use extractLeadingJSON rather than a strict JSON.parse on the full buffer.
          const parsed = extractLeadingJSON(trimmed);
          if (
            parsed !== null &&
            (parsed.type === "function" || typeof parsed.name === "string") &&
            typeof parsed.name === "string"
          ) {
            const toolName = parsed.name as string;
            const args = (parsed.parameters ??
              parsed.arguments ??
              {}) as Record<string, unknown>;
            const callId = crypto.randomUUID();
            hasEmittedToolCall = true;

            // Emit proper tool-call events
            controller.enqueue({
              type: "tool-input-start",
              id: callId,
              toolCallId: callId,
              toolName
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: callId,
              toolCallId: callId,
              delta: JSON.stringify(args)
            });
            controller.enqueue({
              type: "tool-input-end",
              id: callId,
              toolCallId: callId
            });
            controller.enqueue({
              type: "tool-call",
              toolCallId: callId,
              toolName,
              input: JSON.stringify(args)
            });

            textBuffer = "";
            textStartId = null;
            return;
          }

          // Not a tool call — emit buffered text normally
          if (textStartId && textBuffer.length > 0) {
            controller.enqueue({ type: "text-start", id: textStartId });
            controller.enqueue({
              type: "text-delta",
              id: textStartId,
              delta: textBuffer
            });
            controller.enqueue({ type: "text-end", id: textStartId });
          } else if (textStartId) {
            // Empty text - still close the block
            controller.enqueue({ type: "text-start", id: textStartId });
            controller.enqueue({ type: "text-end", id: textStartId });
          }
          textBuffer = "";
          textStartId = null;
        }
      }
    });

    return {
      stream: stream.pipeThrough(transform as TransformStream),
      ...rest
    };
  }
};

// ── Types ─────────────────────────────────────────────────────────────

interface DomainStat {
  correct: number;
  total: number;
}

interface PendingQuestion {
  questionId: string;
  correctAnswer: string;
  domain: string;
  difficulty: string;
  explanation: string;
}

interface StudentProfile {
  name?: string;
  totalAnswered: number;
  totalCorrect: number;
  domainStats: Record<string, DomainStat>;
  weaknesses: string[];
  /** @deprecated Use pendingQuestions. Kept for backward compatibility. */
  pendingQuestion?: PendingQuestion;
  /** Map of questionId -> pending question data (supports multiple questions in chat) */
  pendingQuestions?: Record<string, PendingQuestion>;
}

interface QuestionHistoryRow {
  id: string;
  question_id: string;
  domain: string;
  difficulty: string;
  correct: number;
  answered_at: string;
}

// ── College Board API constants ───────────────────────────────────────

const CB_BASE =
  "https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank/digital";

// Maps natural language → College Board domain code + SAT test number
const DOMAIN_CONFIG: Record<
  string,
  { primaryClassCd: string; test: number; label: string }
> = {
  // Reading & Writing (test 1)
  sec: {
    primaryClassCd: "SEC",
    test: 1,
    label: "Standard English Conventions"
  },
  grammar: {
    primaryClassCd: "SEC",
    test: 1,
    label: "Standard English Conventions"
  },
  "standard english conventions": {
    primaryClassCd: "SEC",
    test: 1,
    label: "Standard English Conventions"
  },
  "standard english": {
    primaryClassCd: "SEC",
    test: 1,
    label: "Standard English Conventions"
  },
  eoi: { primaryClassCd: "EOI", test: 1, label: "Expression of Ideas" },
  "expression of ideas": {
    primaryClassCd: "EOI",
    test: 1,
    label: "Expression of Ideas"
  },
  expression: { primaryClassCd: "EOI", test: 1, label: "Expression of Ideas" },
  iai: { primaryClassCd: "INI", test: 1, label: "Information and Ideas" },
  ini: { primaryClassCd: "INI", test: 1, label: "Information and Ideas" },
  "information and ideas": {
    primaryClassCd: "INI",
    test: 1,
    label: "Information and Ideas"
  },
  information: {
    primaryClassCd: "INI",
    test: 1,
    label: "Information and Ideas"
  },
  reading: { primaryClassCd: "INI", test: 1, label: "Information and Ideas" },
  cas: { primaryClassCd: "CAS", test: 1, label: "Craft and Structure" },
  "craft and structure": {
    primaryClassCd: "CAS",
    test: 1,
    label: "Craft and Structure"
  },
  craft: { primaryClassCd: "CAS", test: 1, label: "Craft and Structure" },
  vocabulary: { primaryClassCd: "CAS", test: 1, label: "Craft and Structure" },
  // Math (test 2)
  algebra: { primaryClassCd: "H", test: 2, label: "Algebra" },
  alg: { primaryClassCd: "H", test: 2, label: "Algebra" },
  "advanced math": { primaryClassCd: "P", test: 2, label: "Advanced Math" },
  advanced: { primaryClassCd: "P", test: 2, label: "Advanced Math" },
  adv: { primaryClassCd: "P", test: 2, label: "Advanced Math" },
  "problem solving": {
    primaryClassCd: "Q",
    test: 2,
    label: "Problem-Solving and Data Analysis"
  },
  "data analysis": {
    primaryClassCd: "Q",
    test: 2,
    label: "Problem-Solving and Data Analysis"
  },
  psda: {
    primaryClassCd: "Q",
    test: 2,
    label: "Problem-Solving and Data Analysis"
  },
  statistics: {
    primaryClassCd: "Q",
    test: 2,
    label: "Problem-Solving and Data Analysis"
  },
  geometry: {
    primaryClassCd: "S",
    test: 2,
    label: "Geometry and Trigonometry"
  },
  trig: { primaryClassCd: "S", test: 2, label: "Geometry and Trigonometry" },
  trigonometry: {
    primaryClassCd: "S",
    test: 2,
    label: "Geometry and Trigonometry"
  },
  "geometry and trigonometry": {
    primaryClassCd: "S",
    test: 2,
    label: "Geometry and Trigonometry"
  },
  math: { primaryClassCd: "H", test: 2, label: "Algebra" }
};

const DIFFICULTY_CODES: Record<string, string> = {
  easy: "E",
  e: "E",
  medium: "M",
  m: "M",
  hard: "H",
  h: "H",
  difficult: "H"
};

function resolveDomain(input: string) {
  const key = input.toLowerCase().trim();
  return (
    DOMAIN_CONFIG[key] ?? DOMAIN_CONFIG["grammar"] // default fallback
  );
}

function resolveDifficulty(input: string): string {
  return DIFFICULTY_CODES[input.toLowerCase().trim()] ?? "M";
}

// College Board API — no authentication required (public educator question bank)
async function cbFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CB_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`College Board API ${res.status}: ${await res.text()}`);
  }
  // Strip BOM (\uFEFF) that some College Board API responses include before
  // the JSON payload, which causes res.json() to throw a SyntaxError.
  const text = await res.text();
  return JSON.parse(text.replace(/^\uFEFF/, "").trim()) as T;
}

// ── System prompt builder ─────────────────────────────────────────────

function buildSystemPrompt(state: StudentProfile): string {
  const accuracy =
    state.totalAnswered > 0
      ? Math.round((state.totalCorrect / state.totalAnswered) * 100)
      : null;

  const domainLines = Object.entries(state.domainStats)
    .filter(([, s]) => s.total > 0)
    .map(([domain, s]) => {
      const pct = Math.round((s.correct / s.total) * 100);
      return `  - ${domain}: ${pct}% (${s.correct}/${s.total})`;
    })
    .join("\n");

  return `You are a Socratic SAT tutor. Your sole purpose is to guide students to discover answers and deepen understanding through questioning — never by giving answers or strategies directly.

## Core Philosophy
You do not teach by telling. You teach by asking. Every explanation you would otherwise give must be converted into a question that leads the student to the insight themselves. A student who reaches an answer through their own reasoning retains it far longer than one who is simply told.

## Student Profile
${state.name ? `Name: ${state.name}` : "Name: Unknown (your first question to a new student should be to ask their name)"}
Overall accuracy: ${accuracy !== null ? `${accuracy}% (${state.totalAnswered} questions answered)` : "No questions answered yet"}

## Performance by Domain
${domainLines || "  No data yet — ask the student which SAT section they want to start with"}

## Weakness Analysis
${state.weaknesses.length > 0
  ? `Weak areas (< 60% accuracy): ${state.weaknesses.join(", ")}. When these topics arise, ask the student to walk you through their thinking before offering any guidance.`
  : "No weak areas identified yet."}

## Socratic Behavior Rules

### Question-First
Before explaining any concept, ask 1–2 probing questions to surface what the student already understands:
- "What do you already know about [concept]?"
- "What did you try first, and why?"
- "What part of the problem feels unclear to you right now?"

### Correction via Questions (Never via Statements)
When a student answers incorrectly, do NOT say "That's wrong" or give the correct answer. Instead, use questions to expose the gap:
- "What does [key word/phrase] in the question tell you?"
- "If that were true, what would that imply about [related fact]? Does that match the passage/problem?"
- "Can you walk me through each step of how you got there?"
Keep asking until the student self-corrects or explicitly asks to be shown the answer after multiple failed attempts.

### Hints as Questions
When a student is stuck, offer a hint in question form — never as a statement:
- Instead of "Remember the distributive property," ask "Which algebraic property might let you expand that expression?"
- Instead of "The tone is negative," ask "What words in the passage give you a feeling about the author's attitude?"

### Reinforce Correct Answers with Reflection
When a student answers correctly, do not simply confirm and move on. Deepen the understanding:
- "That's the right answer — can you explain why the other choices are wrong?"
- "What was the key insight that led you there?"
- "Would the same reasoning work if the problem changed [one element]?"

### Weak Area Metacognition
When a weak domain comes up, open with a metacognitive question before any content:
- "What do you think makes [domain] hard for you?"
- "When you see a [domain] question, what's the first thing that goes through your mind?"

### Clarify Before Acting
If a student asks a vague question ("I don't get it", "explain this"), ask a clarifying question before responding:
- "Which part specifically is unclear — the setup, the calculation, or the answer choices?"
- "What have you tried so far?"

## DEFAULT BEHAVIOR — TEXT ONLY
Your default response is plain conversational text. DO NOT call any tool unless one of the explicit triggers below is met. When in doubt, respond with a question.

## Tool Triggers (ONLY call a tool when the exact condition is met)
- \`fetchSATQuestion\`: Student explicitly asks for a practice question, problem, quiz, or exercise (e.g. "give me a question", "quiz me on algebra", "practice problem"). A short or ambiguous message NEVER triggers this tool.
- \`recordAnswer\`: Message contains the literal text "ANSWER:" — no other condition applies.
- \`getDashboard\`: Message is exactly "DASHBOARD: show" OR student explicitly asks for their progress, stats, score history, or performance breakdown.
- \`explainStrategy\`: Student explicitly asks for a strategy, study tip, or how to improve in a specific area.

## Strict Rules
- NEVER call a tool on a short, vague, or conversational message ("what?", "ok", "thanks", "hm", "why", "how", etc.).
- NEVER call a tool more than once per turn.
- After any tool returns, respond with text only — do not chain another tool call.
- If you are not certain the student is asking for a practice question, answer conversationally and ask a clarifying question.

## SAT Domains
Reading & Writing: Standard English Conventions, Expression of Ideas, Information and Ideas, Craft and Structure
Math: Algebra, Advanced Math, Problem-Solving and Data Analysis, Geometry and Trigonometry

Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;
}

function computeWeaknesses(domainStats: Record<string, DomainStat>): string[] {
  return Object.entries(domainStats)
    .filter(([, s]) => s.total >= 3 && s.correct / s.total < 0.6)
    .sort(([, a], [, b]) => a.correct / a.total - b.correct / b.total)
    .map(([domain]) => domain);
}

// ── Agent ─────────────────────────────────────────────────────────────

export class ChatAgent extends AIChatAgent<Env, StudentProfile> {
  initialState: StudentProfile = {
    totalAnswered: 0,
    totalCorrect: 0,
    domainStats: {},
    weaknesses: [],
    pendingQuestions: {}
  };

  async onStart() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS question_history (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        correct INTEGER NOT NULL DEFAULT 0,
        answered_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    // Pending questions are stored here as the source of truth.
    // Agent state keeps a mirror for client-side UI, but all server-side
    // lookups go through this table to avoid state-hydration race conditions.
    await this.sql`
      CREATE TABLE IF NOT EXISTS pending_questions (
        question_id TEXT PRIMARY KEY,
        correct_answer TEXT NOT NULL,
        domain TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        explanation TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
  }

  onStateChanged(state: StudentProfile, _source: unknown) {
    const newWeaknesses = computeWeaknesses(state.domainStats);
    if (JSON.stringify(newWeaknesses) !== JSON.stringify(state.weaknesses)) {
      this.setState({ ...state, weaknesses: newWeaknesses });
    }
  }

  validateStateChange(nextState: StudentProfile) {
    if (nextState.totalAnswered < 0 || nextState.totalCorrect < 0) {
      throw new Error("Answer counts cannot be negative");
    }
    if (nextState.totalCorrect > nextState.totalAnswered) {
      throw new Error("Correct count cannot exceed total answered");
    }
  }

  @callable()
  async submitAnswer(
    questionId: string,
    selectedAnswer: string
  ): Promise<
    | {
        correct: boolean;
        selectedAnswer: string;
        correctAnswer: string;
        domain: string;
        difficulty: string;
        explanation: string;
      }
    | { error: string }
  > {
    const qid = String(questionId);

    type PendingRow = {
      question_id: string;
      correct_answer: string;
      domain: string;
      difficulty: string;
      explanation: string;
    };
    const rows = await this.sql<PendingRow>`
      SELECT question_id, correct_answer, domain, difficulty, explanation
      FROM pending_questions
      WHERE question_id = ${qid}
    `;
    const row = Array.from(rows)[0];

    const statePending =
      this.state.pendingQuestions?.[qid] ?? this.state.pendingQuestion;

    const pending = row
      ? {
          questionId: row.question_id,
          correctAnswer: row.correct_answer,
          domain: row.domain,
          difficulty: row.difficulty,
          explanation: row.explanation
        }
      : statePending && String(statePending.questionId) === qid
        ? statePending
        : null;

    if (!pending) {
      return {
        error:
          "No active question found for that ID. The question may have expired. Please fetch a new question."
      };
    }

    const normalizedSelected = selectedAnswer.toUpperCase().trim();
    const isCorrect = normalizedSelected === pending.correctAnswer;

    const domainStats = { ...this.state.domainStats };
    const existing = domainStats[pending.domain] ?? { correct: 0, total: 0 };
    domainStats[pending.domain] = {
      correct: existing.correct + (isCorrect ? 1 : 0),
      total: existing.total + 1
    };

    await this.sql`DELETE FROM pending_questions WHERE question_id = ${qid}`;
    await this.sql`
      INSERT INTO question_history (id, question_id, domain, difficulty, correct, answered_at)
      VALUES (
        ${crypto.randomUUID()},
        ${qid},
        ${pending.domain},
        ${pending.difficulty},
        ${isCorrect ? 1 : 0},
        ${new Date().toISOString()}
      )
    `;

    const nextPendingQuestions = { ...(this.state.pendingQuestions ?? {}) };
    delete nextPendingQuestions[qid];

    this.setState({
      ...this.state,
      totalAnswered: this.state.totalAnswered + 1,
      totalCorrect: this.state.totalCorrect + (isCorrect ? 1 : 0),
      domainStats,
      pendingQuestion: undefined,
      pendingQuestions: nextPendingQuestions
    });

    return {
      correct: isCorrect,
      selectedAnswer: normalizedSelected,
      correctAnswer: pending.correctAnswer,
      domain: pending.domain,
      difficulty: pending.difficulty,
      explanation: pending.explanation
    };
  }

  /**
   * Gate tool availability based on the user's last message.
   * The model (@cf/meta/llama-3.3-70b-instruct-fp8-fast) aggressively calls
   * tools on ambiguous or short messages. Providing only the tools that match
   * the user's explicit intent prevents spurious tool invocations.
   */
  private selectActiveTools(
    messages: Awaited<ReturnType<typeof convertToModelMessages>>,
    allTools: ToolSet
  ): ToolSet {
    const last = [...messages]
      .reverse()
      .find(
        (m): m is (typeof messages)[number] & { role: "user" } =>
          m.role === "user"
      );
    if (!last) return {};

    const raw =
      typeof last.content === "string"
        ? last.content
        : Array.isArray(last.content)
          ? last.content
              .filter(
                (p): p is { type: "text"; text: string } =>
                  typeof p === "object" &&
                  (p as { type: string }).type === "text"
              )
              .map((p) => p.text)
              .join(" ")
          : "";

    const t = raw.toLowerCase();

    // ANSWER: is machine-generated by the client UI — exact prefix match only.
    if (raw.trimStart().startsWith("ANSWER:") || raw.includes("ANSWER:")) {
      return allTools.recordAnswer
        ? { recordAnswer: allTools.recordAnswer }
        : {};
    }

    // DASHBOARD: show is normalised by the client.
    if (
      raw.trim() === "DASHBOARD: show" ||
      /\b(dashboard|my progress|my stats|my score|performance|history)\b/.test(
        t
      )
    ) {
      return allTools.getDashboard
        ? { getDashboard: allTools.getDashboard }
        : {};
    }

    // Explicit request for a practice question.
    if (
      /\b(give me|ask me|fetch|get me|quiz me|test me|practice|a question|another question|new question|one question|try a|attempt a|solve|problem|exercise)\b/.test(
        t
      )
    ) {
      return allTools.fetchSATQuestion
        ? { fetchSATQuestion: allTools.fetchSATQuestion }
        : {};
    }

    // Explicit request for strategies / tips.
    // Note: no trailing \b so partial-word prefixes like "strateg" match
    // "strategy", "strategies", etc. and "tip" matches "tips".
    if (
      /\bstrateg|\btips?\b|\badvice\b|\bhow (do i|should i|to)\b|\bhelp me (improve|with|on)\b|\bstudy plan\b|\bweak(ness)?\b|\bimprove my\b/.test(
        t
      )
    ) {
      return allTools.explainStrategy
        ? { explainStrategy: allTools.explainStrategy }
        : {};
    }

    // Conversational turn — no tools needed.
    return {};
  }

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const state = this.state;

    const localTools: ToolSet = {
      fetchSATQuestion: tool({
        description:
          "Fetch a real SAT practice question from the College Board Question Bank. ONLY call this when the student EXPLICITLY and DIRECTLY asks for a practice question, quiz, or problem to solve. Do NOT call this for vague, short, or conversational messages.",
        inputSchema: z.object({
          domain: z
            .string()
            .describe(
              "SAT domain e.g. 'grammar', 'algebra', 'Standard English Conventions', 'reading'"
            ),
          difficulty: z
            .string()
            .describe("Difficulty: 'easy', 'medium', or 'hard'")
        }),
        execute: async ({ domain, difficulty }) => {
          const domainInfo = resolveDomain(domain);
          const difficultyCode = resolveDifficulty(difficulty);

          try {
            // Step 1: Get the list of questions for this domain from College Board
            type QuestionListItem = {
              external_id: string;
              difficulty: string;
              primary_class_cd_desc: string;
              primary_class_cd: string;
              questionId: string;
              skill_desc: string;
            };

            const questions = await cbFetch<QuestionListItem[]>(
              "get-questions",
              {
                asmtEventId: 99, // SAT (99 = SAT, 100 = PSAT/NMSQT, 102 = PSAT 8/9)
                test: domainInfo.test,
                domain: domainInfo.primaryClassCd
              }
            );

            // Step 2: Filter out questions without an external_id — math domains
            // have a significant number of entries (up to 38%) where external_id
            // is null, which causes a 500 VALIDATION_ERROR from get-question.
            const valid = questions.filter((q) => q.external_id);

            // Step 3: Filter by requested difficulty, fall back to any valid question
            const filtered = valid.filter(
              (q) => q.difficulty === difficultyCode
            );
            const pool = filtered.length > 0 ? filtered : valid;

            if (pool.length === 0) {
              return {
                error: `No fetchable questions found for ${domainInfo.label} at difficulty ${difficulty}. Try a different domain or difficulty.`
              };
            }

            // Step 4: Pick a random MCQ question — retry up to 5 times to skip
            // Student-Produced Response (grid-in) questions that have no choices.
            type QuestionDetail = {
              stem: string;
              stimulus?: string;
              answerOptions?: Array<{ id: string; content: string }>;
              correct_answer?: string[];
              keys?: string[];
              rationale?: string;
              type?: string;
            };

            const cleanHtml = (html: string) =>
              decodeHtmlEntities(
                html
                  .replace(/<[^>]*>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim()
              );

            // Shuffle pool so retries pick different questions
            const shuffled = [...pool].sort(() => Math.random() - 0.5);
            let picked = shuffled[0];
            let detail: QuestionDetail | null = null;
            let choiceLetters = ["A", "B", "C", "D"];
            let choices: Record<string, string> = {};
            let correctLetter = "A";
            let stem = "";
            let stimulus: string | null = null;
            let explanation =
              "Review this question carefully and apply the relevant SAT strategy.";

            for (
              let attempt = 0;
              attempt < Math.min(5, shuffled.length);
              attempt++
            ) {
              picked = shuffled[attempt];
              // Step 5: Fetch full question details
              detail = await cbFetch<QuestionDetail>("get-question", {
                external_id: picked.external_id
              });

              const answerOptions = detail.answerOptions ?? [];
              if (answerOptions.length < 2) {
                // SPR (grid-in) question — skip and try the next one
                continue;
              }

              // Step 6: Build A/B/C/D choices map
              choiceLetters = ["A", "B", "C", "D"];
              choices = {};
              answerOptions.slice(0, 4).forEach((opt, i) => {
                choices[choiceLetters[i]] = decodeHtmlEntities(
                  opt.content
                    .replace(/<[^>]*>/g, "")
                    .replace(/\s+/g, " ")
                    .trim()
                );
              });

              // Step 7: Determine correct answer letter
              correctLetter =
                detail.correct_answer?.[0] ??
                (() => {
                  const correctId = detail!.keys?.[0];
                  const idx = answerOptions.findIndex(
                    (o) => o.id === correctId
                  );
                  return idx >= 0 ? choiceLetters[idx] : "A";
                })();

              // Step 8: Clean HTML from stem and stimulus
              stem = cleanHtml(detail.stem ?? "");
              stimulus = detail.stimulus ? cleanHtml(detail.stimulus) : null;
              explanation = detail.rationale
                ? cleanHtml(detail.rationale)
                : "Review this question carefully and apply the relevant SAT strategy.";
              break; // found a valid MCQ question
            }

            if (Object.keys(choices).length < 2) {
              return {
                error: `Could not find a multiple-choice question for ${domainInfo.label} at difficulty ${difficulty}. Try a different difficulty or domain.`
              };
            }

            const questionId = String(picked.external_id);

            // Step 9: Store the correct answer server-side — NEVER sent to the client.
            // SQL is the source of truth; Agent state mirrors it for client UI sync.
            await this.sql`
              INSERT OR REPLACE INTO pending_questions
                (question_id, correct_answer, domain, difficulty, explanation)
              VALUES (
                ${questionId},
                ${correctLetter},
                ${domainInfo.label},
                ${difficultyCode},
                ${explanation}
              )
            `;
            // Mirror into Agent state so the client state UI stays consistent.
            const pendingQuestions = { ...(this.state.pendingQuestions ?? {}) };
            pendingQuestions[questionId] = {
              questionId,
              correctAnswer: correctLetter,
              domain: domainInfo.label,
              difficulty: difficultyCode,
              explanation
            };
            this.setState({
              ...this.state,
              pendingQuestions,
              pendingQuestion: undefined
            });

            // Return question WITHOUT correct answer or explanation to the client
            return {
              questionId,
              domain: domainInfo.label,
              difficulty: difficultyCode,
              questionType: detail?.type ?? "mcq",
              stem,
              stimulus,
              choices,
              choiceCount: Object.keys(choices).length
            };
          } catch (err) {
            console.error("fetchSATQuestion error:", err);
            return {
              error: `Failed to fetch question: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`
            };
          }
        }
      }),

      recordAnswer: tool({
        description:
          "Record the student's answer to the current practice question. Call this as soon as the student tells you which choice they selected.",
        inputSchema: z.object({
          questionId: z
            .string()
            .describe("The question ID from fetchSATQuestion"),
          selectedAnswer: z
            .string()
            .describe("The letter the student chose: A, B, C, or D")
        }),
        execute: async ({ questionId, selectedAnswer }) => {
          return this.submitAnswer(String(questionId), selectedAnswer);
        }
      }),

      getDashboard: tool({
        description:
          "Get the student's full performance dashboard. Call when student types /dashboard or asks to see their progress or stats.",
        inputSchema: z.object({}),
        execute: async () => {
          const domainAgg = await this.sql<{
            domain: string;
            total: number;
            correct: number;
          }>`
            SELECT domain, COUNT(*) as total, SUM(correct) as correct
            FROM question_history
            GROUP BY domain
            ORDER BY total DESC
          `;

          const diffAgg = await this.sql<{
            difficulty: string;
            total: number;
            correct: number;
          }>`
            SELECT difficulty, COUNT(*) as total, SUM(correct) as correct
            FROM question_history
            GROUP BY difficulty
          `;

          const history = await this.sql<QuestionHistoryRow>`
            SELECT * FROM question_history
            ORDER BY answered_at DESC
            LIMIT 10
          `;

          const totalAnswered = this.state.totalAnswered;
          const totalCorrect = this.state.totalCorrect;
          const overallAccuracy =
            totalAnswered > 0
              ? Math.round((totalCorrect / totalAnswered) * 100)
              : 0;

          return {
            studentName: this.state.name ?? "Student",
            overallAccuracy,
            totalAnswered,
            totalCorrect,
            weaknesses: this.state.weaknesses,
            domainBreakdown: Array.from(domainAgg).map((r) => ({
              domain: r.domain,
              total: Number(r.total),
              correct: Number(r.correct),
              accuracy: Math.round((Number(r.correct) / Number(r.total)) * 100)
            })),
            difficultyBreakdown: Array.from(diffAgg).map((r) => ({
              difficulty:
                r.difficulty === "E"
                  ? "Easy"
                  : r.difficulty === "M"
                    ? "Medium"
                    : "Hard",
              total: Number(r.total),
              correct: Number(r.correct),
              accuracy: Math.round((Number(r.correct) / Number(r.total)) * 100)
            })),
            recentHistory: Array.from(history).map((r) => ({
              domain: r.domain,
              difficulty:
                r.difficulty === "E"
                  ? "Easy"
                  : r.difficulty === "M"
                    ? "Medium"
                    : "Hard",
              correct: r.correct === 1,
              answeredAt: r.answered_at
            }))
          };
        }
      }),

      explainStrategy: tool({
        description:
          "Provide targeted SAT study strategies for a specific domain or the student's weakest areas.",
        inputSchema: z.object({
          domain: z
            .string()
            .optional()
            .describe(
              "SAT domain to get strategies for. Leave empty to use the student's weakest area."
            )
        }),
        execute: async ({ domain }) => {
          const targetLabel = domain
            ? resolveDomain(domain).label
            : (this.state.weaknesses[0] ?? "Standard English Conventions");

          const strategies: Record<string, string[]> = {
            "Standard English Conventions": [
              "Read the sentence aloud — your ear often catches grammar errors.",
              "Watch for subject-verb agreement, especially with long phrases between subject and verb.",
              "Commas before coordinating conjunctions (FANBOYS) join two independent clauses.",
              "Semicolons connect two independent clauses; colons introduce lists or explanations.",
              "Apostrophes: 'it's' = 'it is'; 'its' = belonging to it.",
              "Eliminate redundant words — the SAT rewards concise, clear writing."
            ],
            "Expression of Ideas": [
              "Identify the main argument of each paragraph before answering.",
              "Transition questions: choose words that match the logical relationship (contrast, cause-effect, addition).",
              "For sentence placement, check which position makes the paragraph flow most logically.",
              "When adding/deleting sentences, ask: does this support the paragraph's main idea?",
              "Relevance: keep only information that directly supports the passage's purpose."
            ],
            "Information and Ideas": [
              "Read questions before the passage to know what to look for.",
              "Underline evidence in the passage before selecting an answer.",
              "Paired questions: find the answer first, then select the best evidence.",
              "Inference questions: the answer must be directly supported — avoid over-interpreting.",
              "Charts/graphs: read axis labels and units carefully before answering."
            ],
            "Craft and Structure": [
              "Vocabulary in context: substitute your own word before looking at choices.",
              "Purpose questions: ask 'why did the author include this?'",
              "Overall structure: identify whether the passage argues, narrates, compares, or explains.",
              "Tone questions: look for adjectives, verbs, and connotations that reveal attitude.",
              "Cross-text questions: identify agreement, disagreement, or different perspectives."
            ],
            Algebra: [
              "Isolate variables step by step — show all work to avoid sign errors.",
              "Systems of equations: substitution works best when one variable is already isolated.",
              "Check your answer by substituting back into the original equation.",
              "Linear equations: slope = (y₂-y₁)/(x₂-x₁); y-intercept is where x=0.",
              "Flip the inequality sign when multiplying/dividing by a negative number."
            ],
            "Advanced Math": [
              "Factor quadratics by finding two numbers that multiply to c and add to b.",
              "Quadratic formula: x = (-b ± √(b²-4ac)) / 2a.",
              "Exponent rules: multiply → add exponents; divide → subtract; power of power → multiply.",
              "f(x+2) means substitute (x+2) everywhere you see x.",
              "Perfect square: a² + 2ab + b² = (a+b)²."
            ],
            "Problem-Solving and Data Analysis": [
              "Percent change = (new - old) / old × 100.",
              "Unit rate: set up a ratio and cross-multiply.",
              "Mean is pulled toward outliers; median is more robust.",
              "Probability = favorable outcomes / total outcomes.",
              "Scatter plot: line of best fit slope tells you the rate of change."
            ],
            "Geometry and Trigonometry": [
              "Area of circle = πr², circumference = 2πr.",
              "Pythagorean theorem: a² + b² = c² for right triangles.",
              "SOHCAHTOA: sin = opp/hyp, cos = adj/hyp, tan = opp/adj.",
              "Volume of cylinder = πr²h; cone = (1/3)πr²h.",
              "Parallel lines cut by a transversal: corresponding angles are equal."
            ]
          };

          const domainStrategies =
            strategies[targetLabel] ??
            strategies["Standard English Conventions"];
          const domainStat = this.state.domainStats[targetLabel];
          const accuracy =
            domainStat && domainStat.total > 0
              ? Math.round((domainStat.correct / domainStat.total) * 100)
              : null;

          return {
            domain: targetLabel,
            currentAccuracy: accuracy,
            isWeakArea: this.state.weaknesses.includes(targetLabel),
            strategies: domainStrategies,
            tip:
              accuracy !== null && accuracy < 60
                ? `You're at ${accuracy}% in ${targetLabel}. Practice 3-5 questions daily in this area.`
                : `Keep practicing ${targetLabel} to maintain and improve your accuracy.`
          };
        }
      })
    };

    // Wrap with the interceptor middleware so text-encoded tool calls are
    // converted to proper tool-call events (Workers AI streaming quirk)
    const model = wrapLanguageModel({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      middleware: toolCallTextInterceptor
    });

    const modelMessages = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages"
    });

    // Only expose tools that match the user's explicit intent. This prevents
    // the model from calling fetchSATQuestion on short or vague messages.
    const activeTools = this.selectActiveTools(modelMessages, localTools);

    const result = streamText({
      model,
      system: buildSystemPrompt(state),
      messages: modelMessages,
      tools: activeTools,
      onFinish,
      // Cap at 2 steps: 1 tool call + 1 text response
      // (tool result is fed back automatically; the model must respond with text)
      stopWhen: stepCountIs(2),
      // After ANY tool fires, remove ALL tools from the next step so the model
      // MUST respond with text rather than auto-chaining another tool call.
      // Every tool call (recordAnswer, fetchSATQuestion, etc.) is initiated by
      // an explicit user message, so chaining is never correct here.
      prepareStep: async ({ steps }) => {
        const anyToolFired = steps.some((s) => (s.toolCalls?.length ?? 0) > 0);
        if (anyToolFired) {
          return { activeTools: [] };
        }
        return undefined;
      },
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
