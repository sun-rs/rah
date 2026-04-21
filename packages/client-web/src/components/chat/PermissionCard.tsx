import type { PermissionRequest, PermissionResolution, PermissionResponseRequest } from "@rah/runtime-protocol";
import { CheckCircle2, HelpCircle, ShieldAlert, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { ActivityArtifacts } from "./ActivityArtifacts";
import { CompactEventCard } from "./CompactEventCard";

type QuestionInput = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
};

function normalizeQuestions(input: PermissionRequest["input"]): QuestionInput[] {
  const raw = input?.questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>)
    .flatMap((entry) => {
      if (
        typeof entry.id !== "string" ||
        typeof entry.header !== "string" ||
        typeof entry.question !== "string"
      ) {
        return [];
      }
      const options = Array.isArray(entry.options)
        ? entry.options
            .filter((option) => option && typeof option === "object" && !Array.isArray(option))
            .map((option) => option as Record<string, unknown>)
            .flatMap((option) =>
              typeof option.label === "string"
                ? [
                    {
                      label: option.label,
                      ...(typeof option.description === "string"
                        ? { description: option.description }
                        : {}),
                    },
                  ]
                : [],
            )
        : [];
      return [{ id: entry.id, header: entry.header, question: entry.question, options }];
    });
}

function fallbackActions(request: PermissionRequest) {
  if (request.actions && request.actions.length > 0) {
    return request.actions;
  }
  return [
    { id: "allow", label: "Allow", behavior: "allow" as const, variant: "primary" as const },
    { id: "deny", label: "Deny", behavior: "deny" as const, variant: "danger" as const },
  ];
}

function actionClassName(variant?: "primary" | "secondary" | "danger") {
  switch (variant) {
    case "danger":
      return "bg-[var(--app-bg)] border border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]";
    case "secondary":
      return "bg-[var(--app-subtle-bg)] border border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-bg)]";
    case "primary":
    default:
      return "bg-primary text-primary-foreground hover:opacity-90";
  }
}

function buildAnswersPayload(questions: QuestionInput[], values: Record<string, string>) {
  const answers = Object.fromEntries(
    questions
      .map((question) => {
        const value = values[question.id]?.trim();
        if (!value) {
          return null;
        }
        return [question.id, { answers: [value] }];
      })
      .filter((entry): entry is [string, { answers: string[] }] => entry !== null),
  );
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function resolutionLabel(resolution: PermissionResolution) {
  return resolution.selectedActionId ?? resolution.decision ?? resolution.behavior;
}

function resolutionAnswers(
  resolution: PermissionResolution,
): Array<{ questionId: string; answers: string[] }> {
  if (!resolution.answers || typeof resolution.answers !== "object" || Array.isArray(resolution.answers)) {
    return [];
  }
  return Object.entries(resolution.answers).flatMap(([questionId, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const answers = (value as Record<string, unknown>).answers;
    if (!Array.isArray(answers)) {
      return [];
    }
    const normalized = answers.filter((entry): entry is string => typeof entry === "string");
    return normalized.length > 0 ? [{ questionId, answers: normalized }] : [];
  });
}

export function PermissionCard(props: {
  request: PermissionRequest;
  resolution?: PermissionResolution;
  canRespond?: boolean;
  onRespond: (requestId: string, response: PermissionResponseRequest) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = useMemo(() => normalizeQuestions(props.request.input), [props.request.input]);
  const actions = useMemo(() => fallbackActions(props.request), [props.request]);
  const answersPayload = useMemo(
    () => buildAnswersPayload(questions, answers),
    [answers, questions],
  );
  const resolvedAnswers = useMemo(
    () => (props.resolution ? resolutionAnswers(props.resolution) : []),
    [props.resolution],
  );
  const requiresAnswers = questions.length > 0;
  const canSubmit = (!requiresAnswers || answersPayload !== undefined) && (props.canRespond ?? true);

  const submit = (action: (typeof actions)[number]) => {
    props.onRespond(props.request.id, {
      behavior: action.behavior,
      selectedActionId: action.id,
      ...(action.id === "approved" ||
      action.id === "approved_for_session" ||
      action.id === "denied" ||
      action.id === "abort" ||
      action.id === "accept" ||
      action.id === "acceptForSession" ||
      action.id === "decline" ||
      action.id === "cancel"
        ? { decision: action.id }
        : {}),
      ...(answersPayload !== undefined ? { answers: answersPayload } : {}),
    });
  };

  const statusLabel = props.resolution
    ? resolutionLabel(props.resolution)
    : props.request.kind === "question"
      ? "Pending"
      : "Approval";

  return (
    <CompactEventCard
      label={props.request.kind === "question" ? "Question" : "Approval"}
      title={props.request.title}
      {...(props.request.description ? { subtitle: props.request.description } : {})}
      tone="warning"
      status={
        <span className="inline-flex rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
          {statusLabel}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--app-hint)]">
          {props.request.kind === "question" ? (
            <HelpCircle size={13} className="text-[var(--app-warning)]" />
          ) : (
            <ShieldAlert size={13} className="text-[var(--app-warning)]" />
          )}
          <span>{props.request.kind}</span>
        </div>

        {questions.length > 0 ? (
          <div className="space-y-3">
            {questions.map((question) => (
              <section
                key={question.id}
                className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3"
              >
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)]">
                  {question.header}
                </div>
                <div className="mt-1 text-sm text-[var(--app-fg)]">{question.question}</div>
                {question.options.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {question.options.map((option) => {
                      const selected = answers[question.id] === option.label;
                      return (
                        <button
                          key={option.label}
                          type="button"
                          onClick={() =>
                            setAnswers((current) => ({
                              ...current,
                              [question.id]: option.label,
                            }))
                          }
                          className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                            selected
                              ? "border-[var(--ring)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                              : "border-[var(--app-border)] bg-transparent text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                          }`}
                        >
                          <div className="text-sm font-medium">{option.label}</div>
                          {option.description ? (
                            <div className="mt-1 text-xs text-[var(--app-hint)]">
                              {option.description}
                            </div>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <textarea
                    value={answers[question.id] ?? ""}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: event.currentTarget.value,
                      }))
                    }
                    rows={3}
                    className="mt-3 w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                    placeholder="Enter your answer…"
                  />
                )}
              </section>
            ))}
          </div>
        ) : null}

        {props.request.detail?.artifacts?.length ? (
          <ActivityArtifacts artifacts={props.request.detail.artifacts} />
        ) : null}

        {props.resolution ? (
          <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-fg)]">
              {props.resolution.behavior === "allow" ? (
                <CheckCircle2 size={16} className="text-[var(--app-success)]" />
              ) : (
                <XCircle size={16} className="text-[var(--app-danger)]" />
              )}
              <span>{resolutionLabel(props.resolution)}</span>
            </div>
            {props.resolution.message ? (
              <div className="mt-2 text-sm text-[var(--app-hint)]">
                {props.resolution.message}
              </div>
            ) : null}
            {resolvedAnswers.length > 0 ? (
              <div className="mt-3 space-y-2">
                {resolvedAnswers.map((answer) => (
                  <div
                    key={answer.questionId}
                    className="rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                  >
                    <div className="text-xs uppercase tracking-[0.12em] text-[var(--app-hint)]">
                      {answer.questionId}
                    </div>
                    <div className="mt-1">{answer.answers.join(", ")}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((action) => {
              const disabled = action.behavior === "allow" && !canSubmit;
              return (
                <button
                  key={action.id}
                  type="button"
                  disabled={disabled}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${actionClassName(action.variant)}`}
                  onClick={() => submit(action)}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        )}
        {props.canRespond === false && !props.resolution ? (
          <div className="text-xs text-[var(--app-hint)]">
            This client cannot answer live permission requests for the current session mode.
          </div>
        ) : null}
      </div>
    </CompactEventCard>
  );
}
