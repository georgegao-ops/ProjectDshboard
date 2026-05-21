import type { ChatInterpretation, OpenDocContext } from "@contractor/shared";
import { getEnv } from "../config/env";
import { logger } from "../lib/logger";

const CLASSIFIER_TIMEOUT_MS = 1200;

type RulesIntent = ChatInterpretation["intent"];

const ALLOWED_INTENTS: RulesIntent[] = [
  "greeting",
  "file_lookup",
  "active_doc_qa",
  "status_check",
  "schedule_risk",
  "cost_risk",
  "contract_notice",
  "document_summary",
  "general_qa",
];

const ALLOWED_INTENT_SET = new Set<RulesIntent>(ALLOWED_INTENTS);

export interface InterpretationContext {
  query: string;
  activeDocFileName?: string;
  openDocs?: OpenDocContext[];
}

function normalize(input: string): string {
  return input.trim().toLowerCase();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeIntent(input: unknown): RulesIntent {
  if (typeof input !== "string") {
    return "general_qa";
  }

  return ALLOWED_INTENT_SET.has(input as RulesIntent)
    ? (input as RulesIntent)
    : "general_qa";
}

function fromRules(context: InterpretationContext): ChatInterpretation {
  const query = normalize(context.query);

  if (/^(hi|hello|hey|good morning|good afternoon|good evening)$/.test(query)) {
    return {
      intent: "greeting",
      confidence: 0.98,
      source: "rules",
      retrievalHints: {
        preferredCategories: ["correspondence"],
      },
    };
  }

  if (/\b(find|locate|look(ing)? for|do we have|is there)\b/.test(query)) {
    return {
      intent: "file_lookup",
      confidence: 0.86,
      source: "rules",
      retrievalHints: {
        preferredCategories: ["drawing", "spec", "submittal", "rfi"],
      },
    };
  }

  if (
    context.activeDocFileName &&
    /\b(this|that|it|document|file|pdf|drawing|plan|spec)\b/.test(query)
  ) {
    return {
      intent: "active_doc_qa",
      confidence: 0.84,
      source: "rules",
      retrievalHints: {
        preferredTags: ["active_doc"],
      },
    };
  }

  if (/\b(critical path|float|delay|slippage|milestone|tia|schedule)\b/.test(query)) {
    return {
      intent: "schedule_risk",
      confidence: 0.81,
      source: "rules",
      alternatives: [{ intent: "status_check", confidence: 0.42 }],
      retrievalHints: {
        preferredCategories: ["schedule", "report", "rfi"],
        preferredTags: ["schedule", "delay", "milestone"],
        recencyBias: true,
      },
    };
  }

  if (/\b(cost|budget|overrun|change order|billing|retainage|variance|pay application)\b/.test(query)) {
    return {
      intent: "cost_risk",
      confidence: 0.8,
      source: "rules",
      alternatives: [{ intent: "contract_notice", confidence: 0.41 }],
      retrievalHints: {
        preferredCategories: ["change_order", "report", "invoice"],
        preferredTags: ["cost", "budget", "billing", "change_order"],
      },
    };
  }

  if (/\b(notice|contract|claim|liquidated damages|scope change|owner notification)\b/.test(query)) {
    return {
      intent: "contract_notice",
      confidence: 0.78,
      source: "rules",
      retrievalHints: {
        preferredCategories: ["contract", "rfi", "correspondence"],
        preferredTags: ["owner_notice", "rfi"],
      },
    };
  }

  if (/\b(status|latest|recent|open|pending|closed)\b/.test(query)) {
    return {
      intent: "status_check",
      confidence: 0.69,
      source: "rules",
      entities: {
        dateHint: /\b(latest|recent)\b/.test(query) ? "latest" : undefined,
        statusHint: /\bopen\b/.test(query)
          ? "open"
          : /\bpending\b/.test(query)
            ? "pending"
            : /\bclosed\b/.test(query)
              ? "closed"
              : undefined,
      },
      retrievalHints: {
        recencyBias: /\b(latest|recent)\b/.test(query),
      },
    };
  }

  if (/\b(summary|summarize|overview|what is this|big picture)\b/.test(query)) {
    return {
      intent: "document_summary",
      confidence: 0.71,
      source: "rules",
      retrievalHints: {
        preferredCategories: ["report", "drawing", "spec"],
      },
    };
  }

  return {
    intent: "general_qa",
    confidence: 0.55,
    source: "fallback",
    fallbackReason: "no_high_confidence_rule_match",
  };
}

function tryParseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function classifyWithLlm(context: InterpretationContext): Promise<ChatInterpretation | null> {
  const env = getEnv();
  if (!env.openAiApiKey || process.env.CHAT_INTERPRETER_ENABLE_LLM !== "true") {
    return null;
  }
  const endpoint = env.openAiChatEndpoint ?? "https://api.deepseek.com/v1/chat/completions";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: env.openAiChatModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Classify construction chatbot user intent. Return strict JSON with keys intent, confidence, alternatives, entities, retrievalHints. No prose.",
          },
          {
            role: "user",
            content: JSON.stringify({
              query: context.query,
              activeDocFileName: context.activeDocFileName,
              openDocCount: context.openDocs?.length ?? 0,
            }),
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return null;
    }

    const parsed = tryParseJsonObject(content);
    if (!parsed) {
      return null;
    }

    const intent = normalizeIntent(parsed.intent);
    const confidence = clamp01(Number(parsed.confidence ?? 0.5));
    const alternatives = Array.isArray(parsed.alternatives)
      ? parsed.alternatives
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const obj = item as Record<string, unknown>;
            return {
              intent: normalizeIntent(obj.intent),
              confidence: clamp01(Number(obj.confidence ?? 0)),
            };
          })
          .filter((item): item is NonNullable<ChatInterpretation["alternatives"]>[number] => Boolean(item))
          .slice(0, 3)
      : undefined;

    const entities = parsed.entities && typeof parsed.entities === "object"
      ? (parsed.entities as ChatInterpretation["entities"])
      : undefined;
    const retrievalHints = parsed.retrievalHints && typeof parsed.retrievalHints === "object"
      ? (parsed.retrievalHints as ChatInterpretation["retrievalHints"])
      : undefined;

    return {
      intent,
      confidence,
      source: "llm",
      alternatives,
      entities,
      retrievalHints,
    };
  } catch (error) {
    logger.warn("chat.interpretation.classifier_error", {
      reason:
        error instanceof Error && error.name === "AbortError"
          ? `classifier_timeout_${CLASSIFIER_TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : "unknown",
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export const interpretationService = {
  async interpret(context: InterpretationContext): Promise<ChatInterpretation> {
    const trimmedContext: InterpretationContext = {
      ...context,
      query: context.query.trim().slice(0, 1000),
    };

    const rules = fromRules(trimmedContext);
    const llm = await classifyWithLlm(trimmedContext);

    if (llm && llm.confidence >= Math.max(0.7, rules.confidence + 0.08)) {
      return llm;
    }

    return rules;
  },
};
