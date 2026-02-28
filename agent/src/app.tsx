import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { Switch } from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  BugIcon,
  ChartBarIcon,
  BookOpenIcon,
  TrophyIcon,
  WarningIcon
} from "@phosphor-icons/react";

// ── Types ─────────────────────────────────────────────────────────────

interface SATQuestion {
  questionId: string;
  domain: string;
  difficulty: string;
  stem: string;
  stimulus?: string | null;
  imageUrl?: string | null;
  choices: Record<string, string>;
  choiceCount: number;
  error?: string;
}

interface AnswerResult {
  correct: boolean;
  selectedAnswer: string;
  correctAnswer: string;
  domain: string;
  difficulty: string;
  explanation: string;
  error?: string;
}

interface DomainBreakdown {
  domain: string;
  total: number;
  correct: number;
  accuracy: number;
}

interface DifficultyBreakdown {
  difficulty: string;
  total: number;
  correct: number;
  accuracy: number;
}

interface RecentHistory {
  domain: string;
  difficulty: string;
  correct: boolean;
  answeredAt: string;
}

interface DashboardData {
  studentName: string;
  overallAccuracy: number;
  totalAnswered: number;
  totalCorrect: number;
  weaknesses: string[];
  domainBreakdown: DomainBreakdown[];
  difficultyBreakdown: DifficultyBreakdown[];
  recentHistory: RecentHistory[];
  error?: string;
}

// ── Small components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const label =
    difficulty === "E"
      ? "Easy"
      : difficulty === "M"
        ? "Medium"
        : difficulty === "H"
          ? "Hard"
          : difficulty;
  const variant =
    label === "Hard"
      ? "destructive"
      : label === "Easy"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{label}</Badge>;
}

function AccuracyBar({
  accuracy,
  domain
}: {
  accuracy: number;
  domain: string;
}) {
  const color =
    accuracy >= 80
      ? "bg-kumo-success"
      : accuracy >= 60
        ? "bg-kumo-warning"
        : "bg-kumo-danger";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Text size="xs" variant="secondary">
          {domain}
        </Text>
        <Text size="xs" bold>
          {accuracy}%
        </Text>
      </div>
      <div className="w-full h-2 rounded-full bg-kumo-control overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${accuracy}%` }}
        />
      </div>
    </div>
  );
}

// ── SAT Question Renderer ─────────────────────────────────────────────

type AnswerResultData = {
  correct: boolean;
  selectedAnswer: string;
  correctAnswer: string;
  domain: string;
  difficulty: string;
  explanation: string;
};

function SATQuestionView({
  data,
  agentCall
}: {
  data: SATQuestion;
  agentCall: (method: string, args: unknown[]) => unknown;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<AnswerResultData | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);

  if (data.error) {
    return (
      <Surface className="px-4 py-3 rounded-xl ring ring-kumo-danger">
        <div className="flex items-center gap-2">
          <XCircleIcon size={14} className="text-kumo-danger" />
          <Text size="sm" variant="secondary">
            {data.error}
          </Text>
        </div>
      </Surface>
    );
  }

  const choiceLetters = Object.keys(data.choices ?? {}).filter(Boolean);
  const difficultyLabel =
    data.difficulty === "E"
      ? "Easy"
      : data.difficulty === "M"
        ? "Medium"
        : "Hard";

  async function handleSelect(letter: string) {
    if (submitted) return;
    setSelected(letter);
    setSubmitted(true);
    setChecking(true);
    try {
      const res = (await (agentCall("submitAnswer", [
        data.questionId,
        letter
      ]) as Promise<AnswerResultData | { error: string }>)) as
        | AnswerResultData
        | { error: string };
      if ("correct" in res) {
        setResult(res);
      } else {
        setResultError(res.error);
      }
    } catch (e) {
      setResultError(
        e instanceof Error ? e.message : "Failed to submit answer"
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <Surface className="w-full max-w-[85%] rounded-xl ring ring-kumo-line overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b border-kumo-line flex items-center gap-2 flex-wrap">
        <BookOpenIcon size={14} className="text-kumo-brand" />
        <Text size="xs" bold>
          SAT Practice Question
        </Text>
        <Badge variant="secondary">{data.domain}</Badge>
        <DifficultyBadge difficulty={difficultyLabel} />
        {result && (
          <Badge
            variant={result.correct ? "secondary" : "destructive"}
            className="ml-auto"
          >
            {result.correct ? "Correct!" : "Incorrect"}
          </Badge>
        )}
        {checking && (
          <Badge variant="secondary" className="ml-auto">
            Checking…
          </Badge>
        )}
      </div>

      <div className="px-4 py-3 space-y-4">
        {/* Stimulus/passage excerpt */}
        {data.stimulus && (
          <div className="px-3 py-2 bg-kumo-control rounded-lg border-l-2 border-kumo-brand">
            <Text size="sm" variant="secondary">
              {data.stimulus}
            </Text>
          </div>
        )}

        {/* Image if present */}
        {data.imageUrl && (
          <img
            src={data.imageUrl}
            alt="Question diagram"
            className="rounded-lg max-w-full max-h-64 object-contain"
          />
        )}

        {/* Question stem */}
        <div>
          <Text size="sm">{data.stem}</Text>
        </div>

        {/* Answer choices — highlighted correct/incorrect after submission */}
        <div className="space-y-2">
          {choiceLetters.length === 0 && (
            <Text size="sm" variant="secondary">
              No answer choices available for this question.
            </Text>
          )}
          {choiceLetters.map((letter) => {
            const isSelected = selected === letter;
            const isCorrectAnswer = result?.correctAnswer === letter;
            const isWrongAnswer = isSelected && result && !result.correct;

            let rowCls: string;
            let circleCls: string;
            if (result) {
              if (isCorrectAnswer) {
                rowCls =
                  "border-kumo-success bg-kumo-success/10 ring-1 ring-kumo-success cursor-not-allowed";
                circleCls =
                  "bg-kumo-success border-kumo-success text-kumo-inverse";
              } else if (isWrongAnswer) {
                rowCls =
                  "border-kumo-danger bg-kumo-danger/10 ring-1 ring-kumo-danger cursor-not-allowed";
                circleCls =
                  "bg-kumo-danger border-kumo-danger text-kumo-inverse";
              } else {
                rowCls =
                  "border-kumo-line bg-kumo-base cursor-not-allowed opacity-50";
                circleCls = "border-kumo-line text-kumo-inactive";
              }
            } else if (isSelected) {
              rowCls =
                "border-kumo-brand bg-kumo-brand/10 ring-1 ring-kumo-brand cursor-not-allowed";
              circleCls = "bg-kumo-brand border-kumo-brand text-kumo-inverse";
            } else if (submitted) {
              rowCls =
                "border-kumo-line bg-kumo-base cursor-not-allowed opacity-50";
              circleCls = "border-kumo-line text-kumo-inactive";
            } else {
              rowCls =
                "border-kumo-line bg-kumo-base cursor-pointer hover:border-kumo-brand hover:bg-kumo-elevated";
              circleCls = "border-kumo-line text-kumo-inactive";
            }

            return (
              <button
                key={letter}
                type="button"
                disabled={submitted}
                onClick={() => handleSelect(letter)}
                className={[
                  "w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-150",
                  "flex items-start gap-3",
                  rowCls
                ].join(" ")}
              >
                <span
                  className={[
                    "flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border",
                    circleCls
                  ].join(" ")}
                >
                  {letter}
                </span>
                <span className="text-sm text-kumo-default pt-0.5 leading-snug">
                  {(data.choices ?? {})[letter] ?? "(no text)"}
                </span>
              </button>
            );
          })}
        </div>

        {/* Inline result revealed immediately via RPC */}
        {result && (
          <div
            className={[
              "rounded-lg px-3 py-2.5 flex flex-col gap-2",
              result.correct ? "bg-kumo-success/10" : "bg-kumo-danger/10"
            ].join(" ")}
          >
            <div className="flex items-center gap-2">
              {result.correct ? (
                <CheckCircleIcon
                  size={15}
                  className="text-kumo-success flex-shrink-0"
                />
              ) : (
                <XCircleIcon
                  size={15}
                  className="text-kumo-danger flex-shrink-0"
                />
              )}
              <Text size="sm" bold>
                {result.correct
                  ? "Correct!"
                  : `Incorrect — the right answer is ${result.correctAnswer}`}
              </Text>
            </div>
            <button
              type="button"
              onClick={() => setShowExplanation((v) => !v)}
              className="flex items-center gap-1.5 text-kumo-brand hover:opacity-80 transition-opacity w-fit"
            >
              <Text size="xs" bold>
                {showExplanation ? "Hide explanation" : "Show explanation"}
              </Text>
              <CaretDownIcon
                size={12}
                className={`transition-transform ${showExplanation ? "rotate-180" : ""}`}
              />
            </button>
            {showExplanation && (
              <div className="px-3 py-2 bg-kumo-control rounded-lg">
                <Text size="sm" variant="secondary">
                  {result.explanation}
                </Text>
              </div>
            )}
          </div>
        )}

        {resultError && (
          <div className="rounded-lg px-3 py-2 bg-kumo-danger/10 flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger flex-shrink-0" />
            <Text size="sm" variant="secondary">
              {resultError}
            </Text>
          </div>
        )}
      </div>
    </Surface>
  );
}

// ── Answer Result Renderer ────────────────────────────────────────────

function AnswerResultView({ data }: { data: AnswerResult }) {
  const [showExplanation, setShowExplanation] = useState(false);

  if (data.error) {
    return (
      <Surface className="w-full max-w-[85%] rounded-xl ring-2 ring-kumo-danger overflow-hidden">
        <div className="px-4 py-3 flex items-center gap-2">
          <XCircleIcon size={14} className="text-kumo-danger flex-shrink-0" />
          <Text size="sm" variant="secondary">
            {data.error}
          </Text>
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      className={[
        "w-full max-w-[85%] rounded-xl overflow-hidden",
        data.correct ? "ring-2 ring-kumo-success" : "ring-2 ring-kumo-danger"
      ].join(" ")}
    >
      {/* Result header */}
      <div
        className={[
          "px-4 py-3 flex items-center gap-2",
          data.correct ? "bg-kumo-success/10" : "bg-kumo-danger/10"
        ].join(" ")}
      >
        {data.correct ? (
          <CheckCircleIcon size={16} className="text-kumo-success" />
        ) : (
          <XCircleIcon size={16} className="text-kumo-danger" />
        )}
        <Text size="sm" bold>
          {data.correct ? "Correct!" : "Not quite — keep going!"}
        </Text>
        {!data.correct && (
          <span className="text-xs text-kumo-inactive ml-auto">
            Correct: {data.correctAnswer} · You chose: {data.selectedAnswer}
          </span>
        )}
      </div>

      {/* Explanation reveal */}
      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => setShowExplanation((v) => !v)}
          className="flex items-center gap-1.5 text-kumo-brand hover:opacity-80 transition-opacity"
        >
          <Text size="xs" bold>
            {showExplanation ? "Hide explanation" : "Show explanation"}
          </Text>
          <CaretDownIcon
            size={12}
            className={`transition-transform ${showExplanation ? "rotate-180" : ""}`}
          />
        </button>

        {showExplanation && (
          <div className="mt-2 px-3 py-2 bg-kumo-control rounded-lg">
            <Text size="sm" variant="secondary">
              {data.explanation}
            </Text>
          </div>
        )}
      </div>
    </Surface>
  );
}

// ── Dashboard Renderer ────────────────────────────────────────────────

function DashboardView({ data }: { data: DashboardData }) {
  if (data.error) {
    return (
      <Surface className="px-4 py-3 rounded-xl ring ring-kumo-danger">
        <Text size="sm" variant="secondary">
          {data.error}
        </Text>
      </Surface>
    );
  }

  const accuracyColor =
    data.overallAccuracy >= 80
      ? "text-kumo-success"
      : data.overallAccuracy >= 60
        ? "text-kumo-warning"
        : "text-kumo-danger";

  return (
    <Surface className="w-full max-w-[85%] rounded-xl ring ring-kumo-line overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b border-kumo-line flex items-center gap-2">
        <ChartBarIcon size={14} className="text-kumo-brand" />
        <Text size="sm" bold>
          {data.studentName}&apos;s Dashboard
        </Text>
      </div>

      <div className="px-4 py-4 space-y-5">
        {/* Overall stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center px-2 py-3 rounded-lg bg-kumo-control">
            <div className={`text-2xl font-bold ${accuracyColor}`}>
              {data.totalAnswered > 0 ? `${data.overallAccuracy}%` : "—"}
            </div>
            <Text size="xs" variant="secondary">
              Overall
            </Text>
          </div>
          <div className="text-center px-2 py-3 rounded-lg bg-kumo-control">
            <div className="text-2xl font-bold text-kumo-default">
              {data.totalAnswered}
            </div>
            <Text size="xs" variant="secondary">
              Attempted
            </Text>
          </div>
          <div className="text-center px-2 py-3 rounded-lg bg-kumo-control">
            <div className="text-2xl font-bold text-kumo-success">
              {data.totalCorrect}
            </div>
            <Text size="xs" variant="secondary">
              Correct
            </Text>
          </div>
        </div>

        {/* Weaknesses */}
        {data.weaknesses.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <WarningIcon size={13} className="text-kumo-warning" />
              <Text size="xs" bold variant="secondary">
                Areas to improve
              </Text>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {data.weaknesses.map((w) => (
                <Badge key={w} variant="destructive">
                  {w}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Domain breakdown */}
        {data.domainBreakdown.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-3">
              <TrophyIcon size={13} className="text-kumo-brand" />
              <span className="text-xs font-semibold text-kumo-inactive">
                Performance by domain
              </span>
            </div>
            <div className="space-y-3">
              {data.domainBreakdown.map((d) => (
                <AccuracyBar
                  key={d.domain}
                  domain={`${d.domain} (${d.correct}/${d.total})`}
                  accuracy={d.accuracy}
                />
              ))}
            </div>
          </div>
        )}

        {/* Difficulty breakdown */}
        {data.difficultyBreakdown.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-kumo-inactive mb-2">
              By difficulty
            </p>
            <div className="grid grid-cols-3 gap-2">
              {data.difficultyBreakdown.map((d) => (
                <div
                  key={d.difficulty}
                  className="text-center px-2 py-2 rounded-lg bg-kumo-control"
                >
                  <DifficultyBadge difficulty={d.difficulty} />
                  <div className="mt-1 text-sm font-bold text-kumo-default">
                    {d.accuracy}%
                  </div>
                  <Text size="xs" variant="secondary">
                    {d.correct}/{d.total}
                  </Text>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent history */}
        {data.recentHistory.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-kumo-inactive mb-2">
              Recent questions
            </p>
            <div className="space-y-1.5">
              {data.recentHistory.map((h, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 py-1 px-2 rounded-lg bg-kumo-control"
                >
                  {h.correct ? (
                    <CheckCircleIcon
                      size={12}
                      className="text-kumo-success flex-shrink-0"
                    />
                  ) : (
                    <XCircleIcon
                      size={12}
                      className="text-kumo-danger flex-shrink-0"
                    />
                  )}
                  <span className="flex-1 truncate text-xs text-kumo-default">
                    {h.domain}
                  </span>
                  <DifficultyBadge difficulty={h.difficulty} />
                </div>
              ))}
            </div>
          </div>
        )}

        {data.totalAnswered === 0 && (
          <div className="text-center py-4">
            <Text size="sm" variant="secondary">
              No questions answered yet. Ask for a practice question to get
              started!
            </Text>
          </div>
        )}
      </div>
    </Surface>
  );
}

// ── Tool rendering ────────────────────────────────────────────────────

function ToolPartView({
  part,
  addToolApprovalResponse,
  agentCall
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
  agentCall: (method: string, args: unknown[]) => unknown;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  // Completed — custom renderers for SAT tools
  if (part.state === "output-available") {
    const output = part.output as Record<string, unknown>;

    if (toolName === "fetchSATQuestion") {
      return (
        <div className="flex justify-start">
          <SATQuestionView
            data={output as unknown as SATQuestion}
            agentCall={agentCall}
          />
        </div>
      );
    }

    if (toolName === "recordAnswer") {
      return (
        <div className="flex justify-start">
          <AnswerResultView data={output as unknown as AnswerResult} />
        </div>
      );
    }

    if (toolName === "getDashboard") {
      return (
        <div className="flex justify-start">
          <DashboardView data={output as unknown as DashboardData} />
        </div>
      );
    }

    // explainStrategy and generic tools — show compact done state
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {JSON.stringify(output, null, 2)}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  // Needs approval
  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <GearIcon size={14} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approval needed: {toolName}
            </Text>
          </div>
          <div className="font-mono mb-3">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() => {
                if (approvalId)
                  addToolApprovalResponse({ id: approvalId, approved: true });
              }}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => {
                if (approvalId)
                  addToolApprovalResponse({ id: approvalId, approved: false });
              }}
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  // Rejected
  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </Surface>
      </div>
    );
  }

  // Executing
  if (part.state === "input-available" || part.state === "input-streaming") {
    const loadingMessages: Record<string, string> = {
      fetchSATQuestion: "Fetching question from College Board...",
      recordAnswer: "Checking your answer...",
      getDashboard: "Loading your dashboard...",
      explainStrategy: "Preparing study strategies..."
    };

    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
            <Text size="xs" variant="secondary">
              {loadingMessages[toolName] ?? `Running ${toolName}...`}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  return null;
}

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toasts = useKumoToastManager();

  const agent = useAgent({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "scheduled-task") {
            toasts.add({
              title: "Task completed",
              description: data.description,
              timeout: 0
            });
          }
        } catch {
          // Not JSON or not our event
        }
      },
      [toasts]
    )
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    onToolCall: async (event) => {
      if (
        "addToolOutput" in event &&
        event.toolCall.toolName === "getUserTimezone"
      ) {
        event.addToolOutput({
          toolCallId: event.toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  // Normalize commands so the model reliably maps them to tools
  const normalizeForAgent = useCallback((text: string): string => {
    const t = text.trim().toLowerCase();
    if (t === "/dashboard") return "DASHBOARD: show";
    return text.trim();
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: normalizeForAgent(text) }]
    });
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, sendMessage, normalizeForAgent]);

  const starterPrompts = [
    "Give me a hard grammar question",
    "Give me an easy algebra question",
    "Give me a medium reading question",
    "/dashboard",
    "What strategies should I use for Standard English Conventions?"
  ];

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              <span className="mr-2">📚</span>SAT Tutor
            </h1>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} weight="bold" className="mr-1" />
              AI Coach
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<BookOpenIcon size={32} />}
              title="Your SAT Tutor is ready"
              contents={
                <div className="flex flex-wrap justify-center gap-2">
                  {starterPrompts.map((prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      size="sm"
                      disabled={isStreaming}
                      onClick={() => {
                        const normalized =
                          prompt.trim().toLowerCase() === "/dashboard"
                            ? "DASHBOARD: show"
                            : prompt.trim();
                        sendMessage({
                          role: "user",
                          parts: [{ type: "text", text: normalized }]
                        });
                      }}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}

                {/* Tool parts */}
                {message.parts.filter(isToolUIPart).map((part) => (
                  <ToolPartView
                    key={part.toolCallId}
                    part={part}
                    addToolApprovalResponse={addToolApprovalResponse}
                    agentCall={(method, args) => agent.call(method, args)}
                  />
                ))}

                {/* Reasoning parts */}
                {message.parts
                  .filter(
                    (part) =>
                      part.type === "reasoning" &&
                      (part as { text?: string }).text?.trim()
                  )
                  .map((part, i) => {
                    const reasoning = part as {
                      type: "reasoning";
                      text: string;
                      state?: "streaming" | "done";
                    };
                    const isDone = reasoning.state === "done" || !isStreaming;
                    return (
                      <div key={i} className="flex justify-start">
                        <details className="max-w-[85%] w-full" open={!isDone}>
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                            <BrainIcon size={14} className="text-purple-400" />
                            <span className="font-medium text-kumo-default">
                              Reasoning
                            </span>
                            {isDone ? (
                              <span className="text-xs text-kumo-success">
                                Complete
                              </span>
                            ) : (
                              <span className="text-xs text-kumo-brand">
                                Thinking...
                              </span>
                            )}
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-inactive"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                            {reasoning.text}
                          </pre>
                        </details>
                      </div>
                    );
                  })}

                {/* Text parts */}
                {message.parts
                  .filter((part) => part.type === "text")
                  .map((part, i) => {
                    const text = (part as { type: "text"; text: string }).text;
                    if (!text) return null;

                    if (isUser) {
                      return (
                        <div key={i} className="flex justify-end">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                            {text}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={i} className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <Streamdown
                            className="sd-theme rounded-2xl rounded-bl-md p-3"
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder="Ask for a practice question, type /dashboard, or ask for strategies..."
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
