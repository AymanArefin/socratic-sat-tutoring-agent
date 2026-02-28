/**
 * Unit tests for pure helper functions from server.ts.
 * Run with: node tests/helpers.test.mjs
 */

// ── Inline implementations (mirrors server.ts) ────────────────────────

function decodeHtmlEntities(str) {
  const named = {
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
    "&iuml;": "\u00EF",
    "&eacute;": "\u00E9",
    "&egrave;": "\u00E8",
    "&ecirc;": "\u00EA",
    "&euml;": "\u00EB",
    "&agrave;": "\u00E0",
    "&aacute;": "\u00E1",
    "&acirc;": "\u00E2",
    "&atilde;": "\u00E3",
    "&auml;": "\u00E4",
    "&aring;": "\u00E5",
    "&ccedil;": "\u00E7",
    "&oacute;": "\u00F3",
    "&ocirc;": "\u00F4",
    "&ntilde;": "\u00F1",
    "&uuml;": "\u00FC",
    "&uacute;": "\u00FA",
    "&ugrave;": "\u00F9",
    "&ouml;": "\u00F6",
    "&oslash;": "\u00F8"
  };
  return str
    .replace(/&[a-zA-Z]+;/g, (m) => named[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

function extractLeadingJSON(str) {
  if (!str.startsWith("{")) return null;
  let depth = 0,
    inString = false,
    escaped = false;
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
          return JSON.parse(str.slice(0, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── Test runner ───────────────────────────────────────────────────────

let passed = 0,
  failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = "") {
  if (actual !== expected) {
    throw new Error(
      `${msg}\n    expected: ${JSON.stringify(expected)}\n    received: ${JSON.stringify(actual)}`
    );
  }
}

function notNull(val, msg = "") {
  if (val === null || val === undefined) throw new Error(`${msg}: got ${val}`);
}

function isNull(val, msg = "") {
  if (val !== null)
    throw new Error(`${msg}: expected null, got ${JSON.stringify(val)}`);
}

// ── decodeHtmlEntities ────────────────────────────────────────────────
console.log("\ndecodeHtmlEntities");

test("decodes &iuml; to ï (the Chraïbi bug)", () => {
  eq(decodeHtmlEntities("Chra&iuml;bi"), "Chraïbi");
});
test("decodes &eacute;", () => eq(decodeHtmlEntities("caf&eacute;"), "café"));
test("decodes &amp; correctly", () =>
  eq(decodeHtmlEntities("A &amp; B"), "A & B"));
test("decodes &ldquo; and &rdquo;", () => {
  eq(decodeHtmlEntities("&ldquo;hello&rdquo;"), "\u201Chello\u201D");
});
test("decodes numeric decimal &#233;", () =>
  eq(decodeHtmlEntities("&#233;"), "é"));
test("decodes numeric hex &#xE9;", () => eq(decodeHtmlEntities("&#xE9;"), "é"));
test("leaves unknown entities unchanged", () => {
  eq(decodeHtmlEntities("&unknown;"), "&unknown;");
});
test("handles empty string", () => eq(decodeHtmlEntities(""), ""));
test("handles string with no entities", () =>
  eq(decodeHtmlEntities("hello world"), "hello world"));
test("multiple entities in one string", () => {
  eq(decodeHtmlEntities("&eacute;l&egrave;ve"), "élève");
});

// ── extractLeadingJSON ────────────────────────────────────────────────
console.log("\nextractLeadingJSON");

test("parses clean JSON object", () => {
  const result = extractLeadingJSON(
    '{"name":"fetchSATQuestion","parameters":{}}'
  );
  notNull(result, "should not be null");
  eq(result.name, "fetchSATQuestion");
});
test("parses JSON with trailing __ (the raw-text-tool-call bug)", () => {
  const result = extractLeadingJSON(
    '{"name":"fetchSATQuestion","parameters":{"domain":"grammar"}}__'
  );
  notNull(result, "should not be null");
  eq(result.name, "fetchSATQuestion");
});
test("parses JSON with trailing whitespace and text", () => {
  const result = extractLeadingJSON(
    '{"name":"foo","parameters":{}} some extra'
  );
  notNull(result, "should not be null");
  eq(result.name, "foo");
});
test("returns null for non-JSON string", () => {
  isNull(extractLeadingJSON("hello world"), "non-JSON");
});
test("returns null for empty string", () => {
  isNull(extractLeadingJSON(""), "empty");
});
test("returns null for invalid JSON", () => {
  isNull(extractLeadingJSON("{bad json}"), "invalid JSON");
});
test("handles nested objects", () => {
  const result = extractLeadingJSON(
    '{"name":"t","parameters":{"a":{"b":1}}}__'
  );
  notNull(result);
  eq(JSON.stringify(result.parameters), '{"a":{"b":1}}');
});
test("handles strings with braces inside values", () => {
  const result = extractLeadingJSON('{"name":"test","text":"a {b} c"}__');
  notNull(result);
  eq(result.name, "test");
});
test("handles escaped quotes in strings", () => {
  const result = extractLeadingJSON('{"name":"say \\"hello\\""}trailing');
  notNull(result);
  eq(result.name, 'say "hello"');
});

// ── BOM stripping (cbFetch fix) ───────────────────────────────────────
console.log("\nBOM stripping");

test("JSON.parse after BOM removal succeeds", () => {
  const bom = "\uFEFF";
  const raw = `${bom}{"questions":[1,2,3]}`;
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  const parsed = JSON.parse(cleaned);
  eq(parsed.questions.length, 3);
});
test("JSON.parse of normal response still works", () => {
  const raw = '{"questions":[1,2,3]}';
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  const parsed = JSON.parse(cleaned);
  eq(parsed.questions.length, 3);
});

// ── selectActiveTools intent detection ───────────────────────────────
// Inline version mirroring the selectActiveTools logic in server.ts
const TOOLS = {
  fetchSATQuestion: "fetchSATQuestion",
  recordAnswer: "recordAnswer",
  getDashboard: "getDashboard",
  explainStrategy: "explainStrategy"
};

function selectActiveTools(userText) {
  const t = userText.toLowerCase();

  if (
    userText.trimStart().startsWith("ANSWER:") ||
    userText.includes("ANSWER:")
  )
    return ["recordAnswer"];

  if (
    userText.trim() === "DASHBOARD: show" ||
    /\b(dashboard|my progress|my stats|my score|performance|history)\b/.test(t)
  )
    return ["getDashboard"];

  if (
    /\b(give me|ask me|fetch|get me|quiz me|test me|practice|a question|another question|new question|one question|try a|attempt a|solve|problem|exercise)\b/.test(
      t
    )
  )
    return ["fetchSATQuestion"];

  if (
    /\bstrateg|\btips?\b|\badvice\b|\bhow (do i|should i|to)\b|\bhelp me (improve|with|on)\b|\bstudy plan\b|\bweak(ness)?\b|\bimprove my\b/.test(
      t
    )
  )
    return ["explainStrategy"];

  return [];
}

console.log("\nselectActiveTools — intent detection");

test("'what' → no tools (the reported bug)", () => {
  eq(selectActiveTools("what").length, 0);
});
test("'ok' → no tools", () => {
  eq(selectActiveTools("ok").length, 0);
});
test("'thanks' → no tools", () => {
  eq(selectActiveTools("thanks").length, 0);
});
test("'why' → no tools", () => {
  eq(selectActiveTools("why").length, 0);
});
test("'hm' → no tools", () => {
  eq(selectActiveTools("hm").length, 0);
});
test("'Can you explain that?' → no tools", () => {
  eq(selectActiveTools("Can you explain that?").length, 0);
});
test("'Give me a hard algebra question' → fetchSATQuestion", () => {
  eq(
    selectActiveTools("Give me a hard algebra question")[0],
    "fetchSATQuestion"
  );
});
test("'Quiz me on grammar' → fetchSATQuestion", () => {
  eq(selectActiveTools("Quiz me on grammar")[0], "fetchSATQuestion");
});
test("'I want to practice reading' → fetchSATQuestion", () => {
  eq(selectActiveTools("I want to practice reading")[0], "fetchSATQuestion");
});
test("'Give me another question' → fetchSATQuestion", () => {
  eq(selectActiveTools("Give me another question")[0], "fetchSATQuestion");
});
test("'ANSWER: B | questionId: abc123' → recordAnswer", () => {
  eq(selectActiveTools("ANSWER: B | questionId: abc123")[0], "recordAnswer");
});
test("'DASHBOARD: show' → getDashboard", () => {
  eq(selectActiveTools("DASHBOARD: show")[0], "getDashboard");
});
test("'How is my progress?' → getDashboard", () => {
  eq(selectActiveTools("How is my progress?")[0], "getDashboard");
});
test("'What are my stats?' → getDashboard", () => {
  eq(selectActiveTools("What are my stats?")[0], "getDashboard");
});
test("'Any tips for Standard English Conventions?' → explainStrategy", () => {
  eq(
    selectActiveTools("Any tips for Standard English Conventions?")[0],
    "explainStrategy"
  );
});
test("'How do I improve my algebra?' → explainStrategy", () => {
  eq(selectActiveTools("How do I improve my algebra?")[0], "explainStrategy");
});
test("'What strategies should I use for grammar?' → explainStrategy", () => {
  eq(
    selectActiveTools("What strategies should I use for grammar?")[0],
    "explainStrategy"
  );
});
test("'What is the SAT?' → no tools (conversational)", () => {
  eq(selectActiveTools("What is the SAT?").length, 0);
});
test("'Tell me about expression of ideas' → no tools (conversational)", () => {
  eq(selectActiveTools("Tell me about expression of ideas").length, 0);
});

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
