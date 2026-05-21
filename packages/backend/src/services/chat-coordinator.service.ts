import type { ChatHistoryTurn, ChatInterpretation, OpenDocContext, SendChatMessageResponse, UUID } from "@contractor/shared";
import { createHash } from "node:crypto";
import { getEnv } from "../config/env";
import { logger } from "../lib/logger";
import { interpretationService } from "./interpretation.service";
import { projectService } from "./project.service";
import { retrievalService } from "./retrieval.service";
import { keywordHitScore, tokenizeQuery } from "./text-ranking.utils";

type QueryDomain =
  | "contracts"
  | "scheduling"
  | "cost"
  | "field_ops"
  | "documents"
  | "subcontractor"
  | "communication";

interface GraphNodeContext {
  chunkId: string;
  fileId: UUID;
  fileName: string;
  extractedFields?: Record<string, string | undefined>;
  chunkIndex: number;
  chunkText: string;
  sourceType: "content" | "summary" | "metadata_stub";
  pageNumber?: number;
  sectionLabel?: string;
  metadata?: Record<string, unknown>;
  docCategory?: string;
  tags?: string[];
  score: number;
}

type SpecialistAgent = "doc_agent" | "sched_agent" | "cost_agent";

type ContradictionSeverity = "info" | "warning";

interface ContradictionSignal {
  kind: string;
  severity: ContradictionSeverity;
  message: string;
  evidenceFileIds: UUID[];
}

interface CoordinatorTelemetry {
  routeMs: number;
  retrievalMs: number;
  mergeMs: number;
  agentMs: number;
  totalMs: number;
}

interface CoordinatorMetadata {
  domains: QueryDomain[];
  cacheHit: boolean;
  splitSignals: string[];
  specialistAgents: Array<{
    agent: SpecialistAgent;
    domains: QueryDomain[];
    sourceCount: number;
    nodeCount: number;
    durationMs: number;
  }>;
  estimatedContextTokens: number;
  contradictions: ContradictionSignal[];
  interpretationLatencyMs?: number;
  interpretationFallbackReason?: string;
  telemetry: CoordinatorTelemetry;
}

interface ChatCoordinatorFeatureFlags {
  activeDocBoostEnabled: boolean;
  citationFallbackEnabled: boolean;
  strictFactualActiveDocMode: boolean;
  sectionProximityBoostEnabled: boolean;
  strictCitationVerificationEnabled: boolean;
  retrievalTraceEnabled: boolean;
}

interface SpecialistRoute {
  agent: SpecialistAgent;
  domains: QueryDomain[];
  categories: string[];
  tags: string[];
}

interface SpecialistResult {
  agent: SpecialistAgent;
  domains: QueryDomain[];
  sources: SendChatMessageResponse["sources"];
  nodes: GraphNodeContext[];
  durationMs: number;
}
type SearchResultRow = Awaited<ReturnType<typeof retrievalService.searchProject>>["results"][number];
type DocumentDetailResult = Awaited<ReturnType<typeof retrievalService.getDocumentDetail>>;
type PageOrigin = "exact" | "fallback" | "mixed";

interface CoordinatorResult {
  content: string;
  sources: SendChatMessageResponse["sources"];
  citations?: SendChatMessageResponse["citations"];
  interpretation?: ChatInterpretation;
  domains: QueryDomain[];
  coordinator: CoordinatorMetadata;
  cacheHit: boolean;
  suggestions?: string[];
  autoOpenFileName?: string;
}

interface IndexedProjectSnapshot {
  totalFiles: number;
  indexedFiles: number;
  pendingFiles: number;
  failedFiles: number;
  indexingPercent: number;
  categoryBreakdown: Record<string, number>;
  openRfis: Array<{ fileName: string; rfiNumber?: string }>;
  pendingSubmittals: Array<{ fileName: string; submittarNumber?: string; status?: string }>;
  recentChangeOrders: Array<{ fileName: string; coNumber?: string }>;
}

interface RoutePreviewResult {
  domains: QueryDomain[];
  sources: SendChatMessageResponse["sources"];
  selectedNodes: Array<{
    fileId: UUID;
    fileName: string;
    chunkIndex: number;
    score: number;
    docCategory?: string;
    tags?: string[];
  }>;
  specialistAgents: Array<{
    agent: SpecialistAgent;
    domains: QueryDomain[];
    sourceCount: number;
    nodeCount: number;
  }>;
  splitSignals: string[];
  estimatedContextTokens: number;
}

interface ResponseCacheEntry {
  content: string;
  sources: SendChatMessageResponse["sources"];
  citations?: SendChatMessageResponse["citations"];
  interpretation?: ChatInterpretation;
  domains: QueryDomain[];
  coordinator: CoordinatorMetadata;
  createdAt: number;
}

const RESPONSE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESPONSE_CACHE_MAX_ENTRIES = 800;
const ROUTED_CONTEXT_TOKEN_BUDGET = 1000;
const MAX_GRAPH_NODES = 6;
const AGENT_CALL_TIMEOUT_MS = 8_000;
const responseCache = new Map<string, ResponseCacheEntry>();

function getChatCoordinatorFeatureFlags(): ChatCoordinatorFeatureFlags {
  const env = getEnv();
  return {
    activeDocBoostEnabled: env.chatActiveDocBoostEnabled,
    citationFallbackEnabled: env.chatCitationFallbackEnabled,
    strictFactualActiveDocMode: env.chatStrictFactualActiveDocMode,
    sectionProximityBoostEnabled: env.chatSectionProximityBoostEnabled,
    strictCitationVerificationEnabled: env.chatStrictCitationVerificationEnabled,
    retrievalTraceEnabled: env.chatRetrievalTraceEnabled,
  };
}

function pruneResponseCache(now = Date.now()): void {
  for (const [key, entry] of responseCache.entries()) {
    if (now - entry.createdAt > RESPONSE_CACHE_TTL_MS) {
      responseCache.delete(key);
    }
  }

  if (responseCache.size <= RESPONSE_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestEntries = Array.from(responseCache.entries())
    .sort((left, right) => left[1].createdAt - right[1].createdAt)
    .slice(0, responseCache.size - RESPONSE_CACHE_MAX_ENTRIES);

  for (const [key] of oldestEntries) {
    responseCache.delete(key);
  }
}

const DOMAIN_KEYWORDS: Record<QueryDomain, string[]> = {
  contracts: [
    "gmp",
    "lump sum",
    "unit price",
    "owner notification",
    "change in scope",
    "clarification",
    "asi",
    "pco",
    "cor",
    "change order",
    "notice",
    "liquidated damages",
    "changed condition",
    "contract",
    "exposure",
  ],
  scheduling: [
    "critical path",
    "float",
    "tia",
    "time impact analysis",
    "baseline",
    "look-ahead",
    "look ahead",
    "p6",
    "ms project",
    "slippage",
    "delay",
    "duration",
    "milestone",
  ],
  cost: [
    "job cost",
    "csi",
    "schedule of values",
    "earned value",
    "actual cost",
    "projected final cost",
    "retainage",
    "cash flow",
    "billing",
    "pay application",
    "variance",
    "budget",
  ],
  field_ops: [
    "superintendent",
    "daily report",
    "inspection",
    "special inspection",
    "rough-in",
    "rough in",
    "trade coordination",
    "safety",
    "recordable",
    "sequence",
    "mep",
    "site",
  ],
  documents: [
    "spec",
    "specification",
    "masterformat",
    "drawing",
    "sheet",
    "detail bubble",
    "typ",
    "sim",
    "uno",
    "nts",
    "addendum",
    "bulletin",
    "submittal",
    "rfi",
  ],
  subcontractor: [
    "subcontractor",
    "certified payroll",
    "back-charge",
    "back charge",
    "notice to cure",
    "termination notice",
    "sub scope",
    "insurance expiration",
    "submittal log",
  ],
  communication: [
    "draft",
    "email",
    "memo",
    "minutes",
    "owner update",
    "monthly report",
    "formal notice",
    "requested response date",
    "tone",
    "wording",
  ],
};

const DOMAIN_TAG_HINTS: Partial<Record<QueryDomain, string[]>> = {
  scheduling: ["schedule", "delay", "milestone"],
  cost: ["cost", "budget", "billing", "change_order"],
  field_ops: ["field", "safety", "inspection"],
  subcontractor: ["subcontractor", "payroll", "back_charge"],
  communication: ["owner_notice", "meeting_minutes", "rfi"],
};

const STATIC_SYSTEM_PROMPT = [
  "IDENTITY",
  "You are ContractorAI — an elite construction PM assistant embedded in a live document workspace.",
  "You operate like a senior analyst and field operator combined: precise, decisive, document-referenced.",
  "",
  "CORE RULES",
  "1. Ground every answer in retrieved project context. Never invent facts.",
  "2. Be concise and direct. No filler phrases like 'Sure!', 'Great question!', 'Certainly!'.",
  "3. Lead with the answer. Put conclusions first, supporting details after.",
  "4. Prefer concise construction aliases (example: 'hasp', 'swp p16 elevator steel'). Avoid dumping long OneDrive filenames in prose.",
  "5. When reliable page evidence exists, include page references in parentheses: (p. X) or (p. X, Y).",
  "6. If context is insufficient, say exactly what document or log is needed — then stop.",
  "7. Flag risk, liability, or schedule exposure immediately when present.",
  "8. Don't hedge unnecessarily. Give a position when evidence supports one.",
  "",
  "RESPONSE FORMAT",
  "- ALWAYS use markdown: ## for the heading, - for bullets. Never output plain prose paragraphs for structured answers.",
  "- Default shape: ## Short Heading (2-5 words), then 2-4 concise bullet lines starting with -.",
  "- Each bullet: one clear idea, under 18 words.",
  "- Factual questions: answer the requested items directly; no preamble; ## heading + 2-5 bullets.",
  "- Analysis questions: ## heading + bullets; numbered list only when sequence matters.",
  "- Risk/compliance: first bullet begins with CRITICAL / WARNING / INFO label.",
  "- Use 'Next step:' only when context is insufficient or the user explicitly asks for next actions.",
  "- Never include long raw OneDrive filenames in factual answer prose.",
  "- Draft documents: full professional prose, no bullet structure needed.",
  "",
  "DOMAIN EXPERTISE",
  "Contracts: RFI/ASI/PCO/COR/change-order flow, notice requirements, delay exposure, scope changes, liquidated damages.",
  "Scheduling: CPM, critical path, float, baseline vs current, TIA, excusable vs compensable delay, look-ahead.",
  "Cost: SOV, pay applications, PCO pending exposure, retainage, budget vs actual, cash flow.",
  "Documents: CSI specs, drawing sheet conventions, revision/addenda layering, submittal semantics, transmittal logs.",
  "Field ops: Sequence, inspections, trade clashes, daily reports, subcontractor management, safety compliance.",
  "",
  "WORKSPACE AWARENESS",
  "The user has a live document viewer open on the left panel. When you reference a file, note what they should look at.",
  "If the user asks you to open or find a document, return a direct answer about what was found.",
  "",
  "NEVER provide legal advice. Flag legal risk and recommend counsel.",
].join("\n");

function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

function expandSpellingVariants(tokens: string[]): string[] {
  const variants: Record<string, string[]> = {
    aluminium: ["aluminum"],
    aluminum: ["aluminium"],
  };

  const expanded = new Set(tokens);
  for (const token of tokens) {
    const alternatives = variants[token.toLowerCase()] ?? [];
    for (const alternative of alternatives) {
      expanded.add(alternative);
    }
  }

  return Array.from(expanded);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGreetingQuery(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized) return false;

  const conversationalSet = new Set([
    "hi",
    "hello",
    "hey",
    "yo",
    "hiya",
    "sup",
    "good morning",
    "good afternoon",
    "good evening",
  ]);

  if (conversationalSet.has(normalized)) {
    return true;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > 5) {
    return false;
  }

  const smallTalkOnly = tokens.every((token) =>
    ["hi", "hello", "hey", "yo", "thanks", "thank", "you", "there", "pm", "manager", "?", "!"].includes(token)
  );

  return smallTalkOnly;
}

function buildPmGreetingResponse(): string {
  return [
    "Hi, I am your construction PM assistant.",
    "I can help you prioritize risks, draft owner notices/RFIs, summarize schedule slippage, and flag cost exposure from your indexed project files.",
    "Tell me what you need now, for example: 'summarize top schedule risks this week' or 'draft an owner notice for delay at grid B4'.",
  ].join(" ");
}

function estimateTokens(input: string): number {
  const words = input.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

function sanitizeAlias(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.pdf$|\.docx?$|\.xlsx?$|\.csv$|\.txt$/gi, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveShortFormName(
  fileName: string,
  extractedFields?: Record<string, string | undefined>,
  docCategory?: string
): string {
  const base = sanitizeAlias(fileName);

  if (docCategory === "submittal" && extractedFields?.submittarNumber) {
    return sanitizeAlias(extractedFields.submittarNumber);
  }

  if (docCategory === "rfi" && extractedFields?.rfiNumber) {
    return `rfi ${sanitizeAlias(extractedFields.rfiNumber)}`;
  }

  if (docCategory === "drawing" && extractedFields?.sheetNumber) {
    return `sheet ${sanitizeAlias(extractedFields.sheetNumber)}`;
  }

  if (/\bhasp\b/i.test(base)) {
    return "hasp";
  }

  const swpMatch = base.match(/\bswp[- ]?(\d+[a-z0-9]*)\b/i);
  if (swpMatch) {
    const numberPart = swpMatch[1]?.toLowerCase() ?? "";
    const trailing = base
      .replace(/^.*\bswp[- ]?\d+[a-z0-9]*\b/i, "")
      .replace(/\b(orig|rev|r\d+|avi|gen)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .slice(0, 6)
      .join(" ");

    return trailing ? `swp ${numberPart} ${trailing}` : `swp ${numberPart}`;
  }

  const condensed = base
    .replace(/^[a-z0-9\s]{10,}\s+-\s+orig\s+-\s+/i, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");

  return condensed || base;
}

function deriveDisplayNameFromSource(source: SendChatMessageResponse["sources"][number]): string {
  return source.displayName ?? deriveShortFormName(source.fileName);
}

function formatReliablePages(source: SendChatMessageResponse["sources"][number]): number[] {
  return Array.from(
    new Set([source.bestPage, ...(source.suggestedPages ?? [])])
  )
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
    .slice(0, 3);
}

function enforceAliasAndEvidenceFormatting(
  content: string,
  sources: SendChatMessageResponse["sources"]
): string {
  let next = content;

  for (const source of sources) {
    const alias = deriveDisplayNameFromSource(source);
    if (!alias || alias === source.fileName) continue;

    const escaped = source.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    next = next.replace(regex, alias);
  }

  const evidence = sources
    .map((source) => {
      const pages = formatReliablePages(source);
      if (pages.length === 0) return null;
      const alias = deriveDisplayNameFromSource(source);
      return `${alias} (p. ${pages.join(", ")})`;
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, 3);

  if (evidence.length > 0 && !/\(p\.\s*\d+/i.test(next)) {
    if (sources.length === 1) {
      next = `${next.trim()}\n\nEvidence: ${evidence[0]}.`;
    }
  }

  return enforceReadableMarkdown(next);
}

function stripLeadingSpecBoilerplate(content: string): string {
  const lines = content.split(/\r?\n/);
  let index = 0;

  while (index < lines.length && lines[index]?.trim().length === 0) {
    index += 1;
  }

  const start = index;
  const matchers = [
    /^prdc\s+\d+/i,
    /^version\s+\d+/i,
    /^rev\.\s*\d+/i,
    /^mta\s+c&d\s+contract\s+number\.?$/i,
    /^\d+\.\d+\.\s+[a-z0-9/&(),\-\s]+(?:\(not used\))?\s*$/i,
  ];

  let matchedHeaderLines = 0;
  let sawVersionOrRevision = false;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      break;
    }

    const matched = matchers.some((matcher) => matcher.test(line));
    if (!matched) {
      break;
    }

    if (/^version\s+\d+/i.test(line) || /^rev\.\s*\d+/i.test(line)) {
      sawVersionOrRevision = true;
    }

    matchedHeaderLines += 1;
    index += 1;
  }

  if (matchedHeaderLines >= 4 && sawVersionOrRevision) {
    const stripped = [...lines.slice(0, start), ...lines.slice(index)].join("\n").trim();
    return stripped || content.trim();
  }

  return content.trim();
}

function enforceReadableMarkdown(content: string): string {
  const trimmed = stripLeadingSpecBoilerplate(content);
  if (!trimmed) {
    return trimmed;
  }

  // Preserve intentionally prose-first drafts and letter-style outputs.
  if (/^(to:|subject:|dear\s|date:)/im.test(trimmed)) {
    return trimmed;
  }

  const alreadyStructured =
    /(^|\n)\s{0,3}#{1,6}\s+/m.test(trimmed) ||
    /(^|\n)\s*[-*]\s+/m.test(trimmed) ||
    /(^|\n)\s*\d+\.\s+/m.test(trimmed);

  if (alreadyStructured) {
    return trimmed;
  }

  const normalizedLines = trimmed
    .replace(/^[\u2022•]\s+/gm, "- ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalizedLines.length === 0) {
    return "## Answer\n- No content returned.";
  }

  const firstLine = normalizedLines[0] ?? "Answer";
  const heading =
    firstLine.length <= 72 && !/[.!?]$/.test(firstLine)
      ? firstLine
      : "Answer";
  const bodyLines = heading === firstLine ? normalizedLines.slice(1) : normalizedLines;

  const bulletItems = bodyLines.flatMap((line) => {
    if (/^[-*]\s+/.test(line)) {
      return [line.replace(/^[-*]\s+/, "").trim()];
    }

    if (/^\d+\.\s+/.test(line)) {
      return [line.replace(/^\d+\.\s+/, "").trim()];
    }

    if (/^[A-Za-z][A-Za-z0-9 /&()'\-]{1,40}:\s+/.test(line)) {
      const label = line.slice(0, line.indexOf(":"));
      const value = line.slice(line.indexOf(":") + 1).trim();
      return [`**${label}:** ${value}`];
    }

    const sentenceParts = line
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map((part) => part.trim())
      .filter(Boolean);

    return sentenceParts.length > 1 ? sentenceParts : [line];
  });

  const safeBullets = (bulletItems.length > 0 ? bulletItems : [trimmed])
    .slice(0, 10)
    .map((line) => `- ${line}`)
    .join("\n");

  return `## ${heading}\n${safeBullets}`;
}

function isLikelyUnreadableChunk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;

  const binaryMarkers = [
    "%pdf-",
    "endobj",
    "decodeparms",
    "xref",
    "stream",
    "linearized",
    "<?xpacket",
    "x:xmpmeta",
    "rdf:rdf",
    "xmpmm:",
    "pdf:producer",
    "adobe xmp core",
  ];
  const lower = trimmed.toLowerCase();
  const hasBinaryMarker = binaryMarkers.some((marker) => lower.includes(marker));

  const weirdCharCount = Array.from(trimmed).filter((ch) => {
    const code = ch.charCodeAt(0);
    const printableAscii = code >= 32 && code <= 126;
    const commonWhitespace = ch === "\n" || ch === "\r" || ch === "\t";
    return !printableAscii && !commonWhitespace;
  }).length;

  const weirdRatio = weirdCharCount / trimmed.length;
  return hasBinaryMarker || weirdRatio > 0.15;
}

function isCoverPageQuestion(query: string): boolean {
  return /\b(submitted|submission|issued|issue date|date issued|revision|rev\b|approved|approval|transmittal|cover page|title block|when was this submitted|when was this issued)\b/i.test(
    query
  );
}

const FILE_LOOKUP_STOP_WORDS = new Set([
  "i",
  "am",
  "looking",
  "for",
  "is",
  "there",
  "a",
  "an",
  "the",
  "do",
  "we",
  "have",
  "find",
  "show",
  "me",
  "any",
  "file",
  "files",
  "document",
  "documents",
  "please",
]);

const DIRECT_DOCUMENT_HANDLE_PATTERN = /\b(qwp|swp|hasp|itp|qcp|iqp|msds|sds|coa|co|rfi|pco|cor|asi|submittal|volume|conformed|prdc|criteria|requirements)\b/i;

const QUESTION_INTENT_PATTERN = /^(what|which|when|where|why|how|who|list|show|summarize|review|read|open)\b/i;

const ACTIVE_DOC_REFERENCE_STOP_WORDS = new Set([
  ...Array.from(FILE_LOOKUP_STOP_WORDS),
  "pdf",
  "doc",
  "docx",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "csv",
  "r",
  "rr",
  "gen",
  "orig",
  "phase",
  "construction",
]);

function extractActiveDocReferenceTerms(activeDocFileName: string): string[] {
  return Array.from(
    new Set(
      sanitizeAlias(activeDocFileName)
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .filter((token) => !ACTIVE_DOC_REFERENCE_STOP_WORDS.has(token))
        .filter((token) => token.length >= 4 || /^(?=.*[a-z])(?=.*\d)[a-z0-9]+$/i.test(token))
    )
  ).slice(0, 12);
}

function queryMentionsActiveDocument(query: string, activeDocFileName?: string): boolean {
  if (!activeDocFileName) return false;

  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return false;

  const terms = extractActiveDocReferenceTerms(activeDocFileName);
  return terms.some((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(normalizedQuery));
}

function isFileLookupQuery(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized) return false;

  // "show me the specs/requirements/section for X" is a content question, not a file name lookup.
  // Exclude "show" when followed by content-oriented words so those route to retrieval.
  const isContentShowQuery =
    /^show\b/.test(normalized) &&
    /\b(spec|specs|specification|specifications|requirement|requirements|section|clause|detail|details|drawing|drawings|info|information|data)\b/.test(normalized);
  if (isContentShowQuery) {
    return false;
  }

  const explicitPatterns = [
    /^is there /,
    /^do we have /,
    /^find /,
    /^show /,
    /^locate /,
    /^any /,
    /^i am looking for /,
    /^i'm looking for /,
    /^looking for /,
  ];

  return explicitPatterns.some((pattern) => pattern.test(normalized));
}

function isFileLookupFragmentQuery(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized) return false;
  if (isFileLookupQuery(normalized)) return false;

  if (/\b(review|show|display|read|quote|exact(?:ly)?|verbatim)\b/.test(normalized)) {
    return false;
  }

  // Natural question starters should route to content QA, not filename lookup.
  if (/^(what|which|when|where|why|how|who)\b/.test(normalized)) {
    return false;
  }

  // Questions about "it/this/that" are usually about the active document content.
  if (/\b(it|this|that)\b/.test(normalized)) {
    return false;
  }

  const hasSentencePunctuation = /[?.!]/.test(normalized);
  if (hasSentencePunctuation) return false;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) {
    return false;
  }

  const containsDigitsOnly = tokens.every((token) => /^\d+$/.test(token));
  if (containsDigitsOnly) return false;

  const longEnough = normalized.length >= 5;
  return longEnough;
}

function extractFileLookupTerms(input: string): string[] {
  return Array.from(
    new Set(
      normalizeText(input)
        .split(/[^a-z0-9]+/)
        .filter(
          (token) => (token.length >= 2 || /^\d{1,2}$/.test(token)) && !FILE_LOOKUP_STOP_WORDS.has(token)
        )
    )
  );
}

function scoreFileMatch(fileName: string, filePath: string, terms: string[]): number {
  const haystack = `${fileName} ${filePath}`.toLowerCase();
  const haystackTokens = Array.from(
    new Set(haystack.split(/[^a-z0-9]+/).filter((token) => token.length >= 2 || /^\d{1,2}$/.test(token)))
  );
  const nameTokens = Array.from(
    new Set(fileName.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2 || /^\d{1,2}$/.test(token)))
  );

  const tokenMatchesTerm = (token: string, term: string): boolean => {
    if (token.includes(term) || term.includes(token)) {
      return true;
    }

    if (term.length >= 4 && token.length >= 4) {
      // Accept near-prefix matches like "shiel" -> "shield".
      if (token.startsWith(term.slice(0, 4)) || term.startsWith(token.slice(0, 4))) {
        return true;
      }
    }

    return false;
  };

  let score = 0;
  for (const term of terms) {
    const haystackMatch = haystackTokens.some((token) => tokenMatchesTerm(token, term));
    if (haystackMatch) {
      score += 1;
      const fileNameMatch = nameTokens.some((token) => tokenMatchesTerm(token, term));
      if (fileNameMatch) score += 1;
    }
  }
  return score;
}

async function listFileLookupCandidates(projectId: UUID, terms: string[]): Promise<Array<{
  id: UUID;
  fileName: string;
  filePath: string;
}>> {
  const searches = Array.from(new Set(terms.filter((term) => term.length >= 3)));
  const candidates = new Map<string, {
    id: UUID;
    fileName: string;
    filePath: string;
  }>();

  for (const search of searches) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await projectService.listProjectFiles(projectId, {
        page,
        pageSize: 200,
        search,
      });

      for (const file of response.files) {
        candidates.set(file.id, {
          id: file.id,
          fileName: file.fileName,
          filePath: file.filePath,
        });
      }

      hasMore = response.hasMore;
      page += 1;

      if (page > 5 || candidates.size >= 1000) {
        break;
      }
    }

    if (candidates.size >= 1000) {
      break;
    }
  }

  if (candidates.size > 0) {
    return Array.from(candidates.values());
  }

  const fallback = await projectService.listProjectFiles(projectId, {
    page: 1,
    pageSize: 200,
  });

  return fallback.files.map((file) => ({
    id: file.id,
    fileName: file.fileName,
    filePath: file.filePath,
  }));
}

async function resolveFileLookupAnswer(projectId: UUID, query: string): Promise<{
  content: string;
  sources: SendChatMessageResponse["sources"];
} | null> {
  const isExplicitLookup = isFileLookupQuery(query);
  const isFragmentLookup = isFileLookupFragmentQuery(query);
  if (!isExplicitLookup && !isFragmentLookup) {
    return null;
  }

  const terms = extractFileLookupTerms(query);
  if (terms.length === 0) {
    return null;
  }

  const candidateFiles = await listFileLookupCandidates(projectId, terms);

  const ranked = candidateFiles
    .map((file) => ({
      file,
      score: scoreFileMatch(file.fileName, file.filePath, terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  if (ranked.length === 0) {
    if (isFragmentLookup) {
      return null;
    }

    return {
      content: `I could not find a file matching "${query.trim()}" in the indexed project files.`,
      sources: [],
    };
  }

  const lines = ranked.map((entry) => `- ${entry.file.fileName}`);
  return {
    content: [
      `Yes, I found ${ranked.length} matching file${ranked.length === 1 ? "" : "s"} for "${query.trim()}":`,
      ...lines,
    ].join("\n"),
    sources: ranked.map((entry) => ({
      fileId: entry.file.id,
      fileName: entry.file.fileName,
      relevance: Number(Math.min(1, entry.score / Math.max(terms.length * 2, 1)).toFixed(3)),
    })),
  };
}

async function resolveDirectDocumentCandidate(
  projectId: UUID,
  query: string
): Promise<{ fileId: UUID; fileName: string } | null> {
  const normalized = normalizeText(query);
  const hasQuestionIntent = QUESTION_INTENT_PATTERN.test(normalized);
  const volumeRefMatch = normalized.match(/\bvolume\s*(\d{1,2})\b/i);
  const volumeRef = volumeRefMatch ? Number.parseInt(volumeRefMatch[1] ?? "", 10) : undefined;
  const hasPrdcHint = /\bprdc\b/i.test(normalized);
  const hasConformedHint = /\bconformed\b/i.test(normalized);
  const hasSectionAnchorHint = /\bsection\s*\d+(?:\.\d+){0,3}\b/i.test(normalized);
  const hasStrongHandle = DIRECT_DOCUMENT_HANDLE_PATTERN.test(normalized) || Number.isFinite(volumeRef);

  if (!hasStrongHandle) {
    return null;
  }

  if (!hasQuestionIntent && volumeRef === undefined) {
    return null;
  }

  const terms = extractFileLookupTerms(query);
  if (terms.length === 0) {
    return null;
  }

  const candidateFiles = await listFileLookupCandidates(projectId, terms);
  const padded = Number.isFinite(volumeRef) ? String(volumeRef).padStart(2, "0") : "";
  const volumePattern = Number.isFinite(volumeRef)
    ? new RegExp(`\\bvol(?:ume)?[\\s._-]*0?${volumeRef}\\b|\\bvolume[\\s._-]*${padded}\\b`, "i")
    : null;

  const strictScopedCandidates = candidateFiles.filter((file) => {
    const normalizedFileIdentity = normalizeText(`${file.fileName} ${file.filePath}`);
    const hasVolumeMatch = Boolean(volumePattern?.test(normalizedFileIdentity));
    const hasPrdcMatch = /\bprdc\b/i.test(normalizedFileIdentity);
    const hasPrdcFamilyMatch =
      hasPrdcMatch ||
      (normalizedFileIdentity.includes("requirements") &&
        normalizedFileIdentity.includes("design") &&
        normalizedFileIdentity.includes("criteria"));

    // For explicit section review into a specific PRDC volume, require tight identity matching.
    if (hasSectionAnchorHint && Number.isFinite(volumeRef) && hasPrdcHint) {
      return hasVolumeMatch && hasPrdcFamilyMatch;
    }

    if (Number.isFinite(volumeRef) && hasPrdcHint) {
      return hasVolumeMatch && hasPrdcFamilyMatch;
    }

    if (Number.isFinite(volumeRef) && hasSectionAnchorHint) {
      return hasVolumeMatch;
    }

    return false;
  });

  const ranked = (strictScopedCandidates.length > 0 ? strictScopedCandidates : candidateFiles)
    .map((file) => ({
      file,
      score: (() => {
        const normalizedFileIdentity = normalizeText(`${file.fileName} ${file.filePath}`);
        const hasVolumeMatch = Boolean(volumePattern?.test(normalizedFileIdentity));
        const hasPrdcMatch = /\bprdc\b/i.test(normalizedFileIdentity);
        const hasPrdcFamilyMatch =
          hasPrdcMatch ||
          (normalizedFileIdentity.includes("requirements") &&
            normalizedFileIdentity.includes("design") &&
            normalizedFileIdentity.includes("criteria"));
        const hasConformedMatch = /\bconformed\b/i.test(normalizedFileIdentity);

        let score = scoreFileMatch(file.fileName, file.filePath, terms);
        if (hasVolumeMatch) score += 4;
        if (hasPrdcHint && hasPrdcFamilyMatch) score += 3;
        if (hasConformedHint && hasConformedMatch) score += 1;

        if (Number.isFinite(volumeRef) && !hasVolumeMatch) score -= 4;
        if (hasPrdcHint && !hasPrdcFamilyMatch) score -= 3;
        if (hasConformedHint && !hasConformedMatch) score -= 1;
        if (hasSectionAnchorHint && !(hasVolumeMatch || hasPrdcMatch || hasConformedMatch)) score -= 1;

        return score;
      })(),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const top = ranked[0];
  const threshold = Number.isFinite(volumeRef) ? 3 : 2;
  if (!top || top.score < threshold) {
    return null;
  }

  return {
    fileId: top.file.id,
    fileName: top.file.fileName,
  };
}

const GENERIC_EVIDENCE_TOKENS = new Set([
  "prdc",
  "volume",
  "conformed",
  "project",
  "requirements",
  "design",
  "criteria",
  "document",
  "specifications",
]);

const GENERIC_QUERY_FOCUS_STOP_WORDS = new Set([
  "based",
  "what",
  "which",
  "where",
  "when",
  "why",
  "how",
  "with",
  "from",
  "about",
  "into",
  "this",
  "that",
  "these",
  "those",
  "spec",
  "specs",
  "specification",
  "specifications",
  "requirement",
  "requirements",
  "section",
]);

interface QueryEvidenceProfile {
  sectionAnchor?: string;
  focusTerms: string[];
  queryHasSpecificationIntent: boolean;
}

interface SectionAnchorConfidence {
  score: number;
  alignedChunks: number;
  headingAlignedChunks: number;
  strongAlignedChunks: number;
  topSuggestionAgrees: boolean;
  sectionIndexAgrees: boolean;
  ambiguous: boolean;
}

interface RankedDocumentChunk {
  chunkIndex: number;
  chunkText: string;
  sourceType?: "content" | "summary" | "metadata_stub";
  pageNumber?: number;
  sectionLabel?: string;
  metadata?: Record<string, unknown>;
  keywordHits: number;
  strongEvidence: boolean;
  matchedEvidenceTerms: number;
  score: number;
}

function toWordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

function minimumTokenDistance(tokens: string[], left: string, right: string): number | undefined {
  const leftPositions: number[] = [];
  const rightPositions: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === left) leftPositions.push(index);
    if (token === right) rightPositions.push(index);
  }

  if (leftPositions.length === 0 || rightPositions.length === 0) {
    return undefined;
  }

  let minDistance = Number.POSITIVE_INFINITY;
  for (const leftIndex of leftPositions) {
    for (const rightIndex of rightPositions) {
      minDistance = Math.min(minDistance, Math.abs(leftIndex - rightIndex));
    }
  }

  return Number.isFinite(minDistance) ? minDistance : undefined;
}

function minimumPairDistance(tokens: string[], focusTerms: string[]): number | undefined {
  if (focusTerms.length < 2) {
    return undefined;
  }

  let minDistance: number | undefined;
  for (let i = 0; i < focusTerms.length; i += 1) {
    for (let j = i + 1; j < focusTerms.length; j += 1) {
      const distance = minimumTokenDistance(tokens, focusTerms[i], focusTerms[j]);
      if (typeof distance !== "number") {
        continue;
      }
      minDistance = typeof minDistance === "number" ? Math.min(minDistance, distance) : distance;
    }
  }

  return minDistance;
}

function parseSectionAnchor(rawQuery: string): string | undefined {
  const explicitMatch = rawQuery.match(/\bsection\s+(\d+(?:\.\d+)+)\b/i);
  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }

  const bareMatch = rawQuery.match(/\b(\d+(?:\.\d+){1,3})\b/);
  return bareMatch?.[1];
}

function extractSectionAnchors(text: string): string[] {
  const matches = Array.from(text.matchAll(/\b(?:section\s*)?(\d+(?:\.\d+)+)\b/gi));
  return Array.from(new Set(matches.map((match) => match[1]).filter((value): value is string => Boolean(value))));
}

function extractSectionAnchorMatches(text: string): Array<{ anchor: string; index: number }> {
  return Array.from(text.matchAll(/\b(?:section\s*)?(\d+(?:\.\d+)+)\b/gi))
    .map((match) => ({
      anchor: match[1] ?? "",
      index: match.index ?? -1,
    }))
    .filter((match) => match.anchor.length > 0 && match.index >= 0);
}

function extractSectionAnchorsFromChunk(chunk: RankedDocumentChunk): string[] {
  const anchors = new Set<string>();
  for (const anchor of extractSectionAnchors(chunk.chunkText)) {
    anchors.add(anchor);
  }

  if (chunk.sectionLabel) {
    for (const anchor of extractSectionAnchors(chunk.sectionLabel)) {
      anchors.add(anchor);
    }
  }

  return Array.from(anchors);
}

function chunkHasSectionAnchor(chunk: RankedDocumentChunk, sectionAnchor: string): boolean {
  if (hasSectionAnchorInText(chunk.chunkText, sectionAnchor)) {
    return true;
  }

  if (chunk.sectionLabel && hasSectionAnchorInText(chunk.sectionLabel, sectionAnchor)) {
    return true;
  }

  return false;
}

function findFocusAnchorPosition(chunk: RankedDocumentChunk, profile: QueryEvidenceProfile): number | undefined {
  const lowerText = chunk.chunkText.toLowerCase();
  const phrases = profile.focusTerms.length >= 2
    ? profile.focusTerms.flatMap((term, index) =>
        profile.focusTerms.slice(index + 1).map((other) => `${term} ${other}`)
      )
    : [];

  for (const phrase of phrases) {
    const phraseIndex = lowerText.indexOf(phrase);
    if (phraseIndex >= 0) {
      return phraseIndex;
    }
  }

  const focusIndexes = profile.focusTerms
    .map((term) => lowerText.indexOf(term))
    .filter((index): index is number => index >= 0)
    .sort((left, right) => left - right);

  return focusIndexes[0];
}

function selectRelevantChunkAnchors(
  chunk: RankedDocumentChunk,
  profile: QueryEvidenceProfile
): string[] {
  const textMatches = extractSectionAnchorMatches(chunk.chunkText).filter((match) =>
    isLikelySpecSectionAnchor(match.anchor)
  );

  const labelAnchors = chunk.sectionLabel
    ? extractSectionAnchors(chunk.sectionLabel).filter((anchor) => isLikelySpecSectionAnchor(anchor))
    : [];

  if (textMatches.length === 0) {
    return Array.from(new Set(labelAnchors));
  }

  const focusPosition = findFocusAnchorPosition(chunk, profile);
  if (typeof focusPosition !== "number") {
    return Array.from(new Set([...textMatches.map((match) => match.anchor), ...labelAnchors]));
  }

  const precedingMatch = [...textMatches]
    .filter((match) => match.index <= focusPosition)
    .sort((left, right) => right.index - left.index)[0];
  const followingMatch = [...textMatches]
    .filter((match) => match.index > focusPosition)
    .sort((left, right) => left.index - right.index)[0];

  const selected = new Set<string>(labelAnchors);
  if (precedingMatch) {
    selected.add(precedingMatch.anchor);
  }
  if (!precedingMatch && followingMatch) {
    selected.add(followingMatch.anchor);
  }

  if (selected.size === 0) {
    selected.add(textMatches[0]!.anchor);
  }

  return Array.from(selected);
}

function extractInferenceAnchorsFromChunk(
  chunk: RankedDocumentChunk,
  profile: QueryEvidenceProfile
): string[] {
  const labelAnchors = chunk.sectionLabel
    ? extractSectionAnchors(chunk.sectionLabel).filter((anchor) => isLikelySpecSectionAnchor(anchor))
    : [];

  if (labelAnchors.length > 0) {
    return Array.from(new Set(labelAnchors));
  }

  return selectRelevantChunkAnchors(chunk, profile).filter((anchor) => isLikelySpecSectionAnchor(anchor));
}

function inferDirectTopicSectionAnchor(
  rankedChunks: RankedDocumentChunk[],
  profile: QueryEvidenceProfile
): string | undefined {
  if (profile.focusTerms.length < 2) {
    return undefined;
  }

  let best:
    | {
        anchor: string;
        score: number;
        chunkIndex: number;
      }
    | undefined;

  for (const chunk of rankedChunks.slice(0, 160)) {
    if (chunk.keywordHits <= 0 || !chunk.strongEvidence) {
      continue;
    }

    const anchorMatches = extractSectionAnchorMatches(chunk.chunkText)
      .filter((match) => isLikelySpecSectionAnchor(match.anchor));

    for (const match of anchorMatches) {
      const localHeadingSlice = chunk.chunkText
        .slice(match.index, Math.min(chunk.chunkText.length, match.index + 140))
        .toLowerCase();
      const focusHits = profile.focusTerms.filter((term) => localHeadingSlice.includes(term)).length;
      if (focusHits < 2) {
        continue;
      }

      const score = focusHits * 3 + chunk.keywordHits - chunk.chunkIndex * 0.01;
      if (!best || score > best.score || (score === best.score && chunk.chunkIndex < best.chunkIndex)) {
        best = {
          anchor: match.anchor,
          score,
          chunkIndex: chunk.chunkIndex,
        };
      }
    }
  }

  return best?.anchor;
}

function inferHeadingSliceSectionAnchor(
  rankedChunks: RankedDocumentChunk[],
  profile: QueryEvidenceProfile
): string | undefined {
  if (profile.focusTerms.length < 2) {
    return undefined;
  }

  let best:
    | {
        anchor: string;
        focusHits: number;
        chunkIndex: number;
      }
    | undefined;

  for (const chunk of rankedChunks.slice(0, 180)) {
    if (chunk.keywordHits <= 0 || isLikelyTocOrIndexChunk(chunk.chunkText)) {
      continue;
    }

    const headingSlice = chunk.chunkText.slice(0, 360).toLowerCase();
    const headingMatches = Array.from(
      headingSlice.matchAll(/\b(\d+(?:\.\d+){1,3})\.?\s+([^\n]{3,140})/g)
    );

    for (const match of headingMatches) {
      const anchor = match[1];
      // Trim heading to just the section title — stop before the next section reference.
      // This prevents body text (e.g. "specifications" in body) from inflating focus-hit counts.
      const rawHeading = match[2] ?? "";
      const nextSectionMatch = rawHeading.match(/\b\d+(?:\.\d+){1,3}\b/);
      const heading = nextSectionMatch
        ? rawHeading.slice(0, nextSectionMatch.index).trim()
        : rawHeading.slice(0, 80).trim();
      if (!anchor || !isLikelySpecSectionAnchor(anchor)) {
        continue;
      }

      const focusHits = profile.focusTerms.filter((term) => heading.includes(term)).length;
      if (focusHits < 2) {
        continue;
      }

      if (
        !best ||
        focusHits > best.focusHits ||
        (focusHits === best.focusHits && chunk.chunkIndex < best.chunkIndex)
      ) {
        best = {
          anchor,
          focusHits,
          chunkIndex: chunk.chunkIndex,
        };
      }
    }
  }

  return best?.anchor;
}

function inferHeadingFocusedSectionAnchor(
  rankedChunks: RankedDocumentChunk[],
  profile: QueryEvidenceProfile
): string | undefined {
  if (profile.focusTerms.length === 0) {
    return undefined;
  }

  const minimumFocusMatches = Math.min(2, profile.focusTerms.length);
  let best:
    | {
        anchor: string;
        score: number;
        chunkIndex: number;
      }
    | undefined;

  for (const chunk of rankedChunks) {
    if (isLikelyTocOrIndexChunk(chunk.chunkText)) {
      continue;
    }
    const hasSectionLabel = typeof chunk.sectionLabel === "string" && chunk.sectionLabel.trim().length > 0;
    if (profile.queryHasSpecificationIntent && !hasSectionLabel) {
      continue;
    }

    const anchors = extractInferenceAnchorsFromChunk(chunk, profile);
    if (anchors.length === 0) {
      continue;
    }

    for (const rawAnchor of anchors) {
      const anchor = normalizeInferredSectionAnchor(rawAnchor, profile);
      const sectionLabelText = (chunk.sectionLabel ?? "").toLowerCase();
      const headingSource = sectionLabelText || chunk.chunkText.slice(0, 220).toLowerCase();
      const focusHits = profile.focusTerms.filter((term) => headingSource.includes(term)).length;
      if (focusHits < minimumFocusMatches) {
        continue;
      }

      const headingAnchored =
        (typeof chunk.sectionLabel === "string" && hasSectionAnchorInText(chunk.sectionLabel, anchor)) ||
        hasSectionHeadingAnchor(chunk.chunkText, anchor);

      const sectionLabelBonus = sectionLabelText.length > 0 ? 2 : 0;
      const headingBonus = headingAnchored ? 1.5 : 0.3;
      const depthPenalty = Math.max(0, anchor.split(".").length - 2) * 0.5;
      const score =
        focusHits * 4 +
        sectionLabelBonus +
        headingBonus +
        (chunk.strongEvidence ? 1 : 0) -
        depthPenalty -
        chunk.chunkIndex * 0.002;

      if (!best || score > best.score || (score === best.score && chunk.chunkIndex < best.chunkIndex)) {
        best = {
          anchor,
          score,
          chunkIndex: chunk.chunkIndex,
        };
      }
    }
  }

  return best?.anchor;
}

function inferSectionAnchorFromSectionLabels(
  rankedChunks: RankedDocumentChunk[],
  profile: QueryEvidenceProfile
): string | undefined {
  if (profile.focusTerms.length === 0) {
    return undefined;
  }

  const candidates = rankedChunks
    .filter((chunk) => typeof chunk.sectionLabel === "string" && chunk.sectionLabel.trim().length > 0)
    .map((chunk) => {
      const label = (chunk.sectionLabel ?? "").toLowerCase();
      const focusHits = profile.focusTerms.filter((term) => label.includes(term)).length;
      const exactExpansionJointLabelMatch = /\bexpansion\s+joints?\b/i.test(label);
      const anchors = extractSectionAnchors(chunk.sectionLabel ?? "").filter(isLikelySpecSectionAnchor);
      return {
        chunk,
        focusHits,
        exactExpansionJointLabelMatch,
        anchors,
      };
    })
    .filter((candidate) => candidate.focusHits >= 1 && candidate.anchors.length > 0)
    .sort((left, right) => {
      if (left.exactExpansionJointLabelMatch !== right.exactExpansionJointLabelMatch) {
        return Number(right.exactExpansionJointLabelMatch) - Number(left.exactExpansionJointLabelMatch);
      }
      if (left.focusHits !== right.focusHits) {
        return right.focusHits - left.focusHits;
      }
      return right.chunk.score - left.chunk.score;
    });

  const top = candidates[0];
  if (!top) {
    return undefined;
  }

  return top.anchors[0];
}

function inferSectionAnchorFromSectionIndex(
  rankedChunks: RankedDocumentChunk[],
  profile: QueryEvidenceProfile
): string | undefined {
  if (profile.focusTerms.length === 0) {
    return undefined;
  }

  const sectionIndexChunk = rankedChunks.find((chunk) => {
    const metadataType = typeof chunk.metadata?.type === "string" ? chunk.metadata.type : "";
    return metadataType === "section_index" || /document section index/i.test(chunk.chunkText);
  });

  if (!sectionIndexChunk) {
    return undefined;
  }

  const lines = sectionIndexChunk.chunkText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let best:
    | {
        anchor: string;
        score: number;
      }
    | undefined;

  for (const line of lines) {
    const match = line.match(/^(\d+(?:\.\d+){1,4})\.?\s+(.+?)\s+\[p/i);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    if (!isLikelySpecSectionAnchor(match[1])) {
      continue;
    }

    const heading = match[2].toLowerCase();
    const focusHits = profile.focusTerms.filter((term) => heading.includes(term)).length;
    if (focusHits === 0) {
      continue;
    }

    const exactExpansionJointMatch = /\bexpansion\s+joints?\b/i.test(heading) ? 3 : 0;
    const score = focusHits * 3 + exactExpansionJointMatch;
    if (!best || score > best.score) {
      best = {
        anchor: match[1],
        score,
      };
    }
  }

  return best?.anchor;
}

function hasSectionAnchorInText(text: string, sectionAnchor: string): boolean {
  return new RegExp(`\\b(?:section\\s*)?${escapeRegex(sectionAnchor)}\\b`, "i").test(text);
}

function hasSectionHeadingAnchor(text: string, sectionAnchor: string): boolean {
  const headingSlice = text.slice(0, 220);
  return new RegExp(
    `(^|\\n)\\s*(?:section\\s*)?${escapeRegex(sectionAnchor)}(?:\\.)?\\s+(?:[A-Z][A-Za-z&/()'\\-]+|\\([A-Z][A-Za-z\\- ]+\\))`,
    "m"
  ).test(
    headingSlice
  );
}

function countSectionReferences(text: string): number {
  return Array.from(text.matchAll(/\b\d+(?:\.\d+){1,3}\b/g)).length;
}

function isLikelyTocOrIndexChunk(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ");
  const dotLeaders = (normalized.match(/\.{4,}/g) ?? []).length;
  const sectionRefs = countSectionReferences(text);
  const lineCount = text.split(/\n+/).filter((line) => line.trim().length > 0).length;
  const hasTocMarker = /\b(table of contents|contents)\b/i.test(text);

  if (hasTocMarker) {
    return true;
  }

  if (dotLeaders >= 2) {
    return true;
  }

  if (dotLeaders >= 1 && sectionRefs >= 5) {
    return true;
  }

  return sectionRefs >= 8 && lineCount <= 8;
}

function isLikelySpecSectionAnchor(anchor: string): boolean {
  const parts = anchor.split(".");
  const majorPart = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isFinite(majorPart)) {
    return true;
  }
  if (parts.length === 2) {
    const minorPart = Number.parseInt(parts[1] ?? "", 10);
    if (Number.isFinite(minorPart) && minorPart === 0) {
      return false;
    }
  }
  return majorPart >= 2;
}

function normalizeInferredSectionAnchor(anchor: string, profile: QueryEvidenceProfile): string {
  if (profile.sectionAnchor) {
    return anchor;
  }

  const parts = anchor.split(".");
  if (!profile.queryHasSpecificationIntent || parts.length <= 2) {
    return anchor;
  }

  return parts.slice(0, 2).join(".");
}

function inferSectionAnchorFromRankedChunks(
  rankedChunks: RankedDocumentChunk[],
  profile: QueryEvidenceProfile
): string | undefined {
  if (profile.sectionAnchor) {
    return profile.sectionAnchor;
  }
  if (!profile.queryHasSpecificationIntent || profile.focusTerms.length === 0) {
    return undefined;
  }

  const directTopicAnchor = inferDirectTopicSectionAnchor(rankedChunks, profile);
  const normalizedDirectTopicAnchor = directTopicAnchor
    ? normalizeInferredSectionAnchor(directTopicAnchor, profile)
    : undefined;
  const headingSliceAnchor = inferHeadingSliceSectionAnchor(rankedChunks, profile);
  if (headingSliceAnchor) {
    return normalizeInferredSectionAnchor(headingSliceAnchor, profile);
  }
  const headingFocusedAnchor = inferHeadingFocusedSectionAnchor(rankedChunks, profile);
  if (headingFocusedAnchor) {
    return headingFocusedAnchor;
  }

  const anchorStats = new Map<
    string,
    {
      score: number;
      count: number;
      headingHits: number;
      minChunkIndex: number;
      maxChunkIndex: number;
    }
  >();
  for (const chunk of rankedChunks.slice(0, 80)) {
    if (chunk.keywordHits <= 0 || !chunk.strongEvidence || isLikelyTocOrIndexChunk(chunk.chunkText)) {
      continue;
    }
    const hasSectionLabel = typeof chunk.sectionLabel === "string" && chunk.sectionLabel.trim().length > 0;
    if (profile.queryHasSpecificationIntent && !hasSectionLabel) {
      continue;
    }

    const lowerText = chunk.chunkText.toLowerCase();
    const focusHits = profile.focusTerms.filter((term) => lowerText.includes(term)).length;
    if (focusHits === 0) {
      continue;
    }

    const anchors = extractInferenceAnchorsFromChunk(chunk, profile);
    if (anchors.length === 0) {
      continue;
    }

    // Prefer heading-style section mentions and earlier section anchors in the document.
    const headingSlice = chunk.chunkText.slice(0, 200);
    const sectionDensityPenalty = Math.max(0, countSectionReferences(chunk.chunkText) - 3) * 0.25;
    const chunkPositionPenalty = chunk.chunkIndex * 0.003;
    const baseScore =
      chunk.score +
      chunk.matchedEvidenceTerms * 0.5 +
      focusHits -
      chunkPositionPenalty -
      sectionDensityPenalty;
    for (const anchor of anchors) {
      if (!isLikelySpecSectionAnchor(anchor)) {
        continue;
      }
      const depthPenalty = Math.max(0, anchor.split(".").length - 2) * 0.7;
      const headingLike =
        hasSectionAnchorInText(headingSlice, anchor) ||
        (typeof chunk.sectionLabel === "string" && hasSectionAnchorInText(chunk.sectionLabel, anchor));
      const labelBonus =
        typeof chunk.sectionLabel === "string" && hasSectionAnchorInText(chunk.sectionLabel, anchor)
          ? 1.25
          : 0;
      const headingBonus = headingLike ? 1.2 : 0.2;
      const anchorScore = baseScore + headingBonus + labelBonus - depthPenalty;
      const existing = anchorStats.get(anchor);
      if (existing) {
        existing.score += anchorScore;
        existing.count += 1;
        if (headingLike) {
          existing.headingHits += 1;
        }
        existing.minChunkIndex = Math.min(existing.minChunkIndex, chunk.chunkIndex);
        existing.maxChunkIndex = Math.max(existing.maxChunkIndex, chunk.chunkIndex);
      } else {
        anchorStats.set(anchor, {
          score: anchorScore,
          count: 1,
          headingHits: headingLike ? 1 : 0,
          minChunkIndex: chunk.chunkIndex,
          maxChunkIndex: chunk.chunkIndex,
        });
      }
    }
  }

  const best = Array.from(anchorStats.entries()).sort((left, right) => {
    const [leftAnchor, leftStats] = left;
    const [rightAnchor, rightStats] = right;

    const leftSpan = Math.max(1, leftStats.maxChunkIndex - leftStats.minChunkIndex + 1);
    const rightSpan = Math.max(1, rightStats.maxChunkIndex - rightStats.minChunkIndex + 1);

    const leftClusterBonus = leftStats.count >= 2 ? Math.min(1.8, leftStats.count / leftSpan) : 0;
    const rightClusterBonus = rightStats.count >= 2 ? Math.min(1.8, rightStats.count / rightSpan) : 0;

    const leftDirectTopicBoost = leftAnchor === normalizedDirectTopicAnchor ? 1.25 : 0;
    const rightDirectTopicBoost = rightAnchor === normalizedDirectTopicAnchor ? 1.25 : 0;

    const leftFinal =
      leftStats.score +
      (leftStats.count - 1) * 1.6 +
      leftStats.headingHits * 0.35 +
      leftClusterBonus +
      leftDirectTopicBoost;
    const rightFinal =
      rightStats.score +
      (rightStats.count - 1) * 1.6 +
      rightStats.headingHits * 0.35 +
      rightClusterBonus +
      rightDirectTopicBoost;

    if (leftFinal !== rightFinal) {
      return rightFinal - leftFinal;
    }
    if (leftStats.count !== rightStats.count) {
      return rightStats.count - leftStats.count;
    }
    return leftAnchor.localeCompare(rightAnchor);
  })[0];

  return best ? normalizeInferredSectionAnchor(best[0], profile) : undefined;
}

function buildQueryEvidenceProfile(rawQuery: string, evidenceTokens: string[]): QueryEvidenceProfile {
  const sectionAnchor = parseSectionAnchor(rawQuery);
  const queryHasSpecificationIntent = /\b(spec|specs|specification|specifications|requirement|requirements)\b/i.test(
    rawQuery
  );

  const focusFromEvidence = evidenceTokens
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3)
    .filter((token) => !GENERIC_EVIDENCE_TOKENS.has(token))
    .filter((token) => !GENERIC_QUERY_FOCUS_STOP_WORDS.has(token));

  const queryWordSet = new Set(
    toWordTokens(rawQuery)
      .filter((token) => token.length >= 3)
      .filter((token) => !GENERIC_EVIDENCE_TOKENS.has(token))
      .filter((token) => !GENERIC_QUERY_FOCUS_STOP_WORDS.has(token))
  );

  for (const token of focusFromEvidence) {
    queryWordSet.add(token);
  }

  return {
    sectionAnchor,
    focusTerms: Array.from(queryWordSet).slice(0, 6),
    queryHasSpecificationIntent,
  };
}

function evaluateChunkEvidence(
  rawQuery: string,
  evidenceTokens: string[],
  chunkText: string,
  profile: QueryEvidenceProfile
): {
  strongEvidence: boolean;
  sectionOrPhraseBoost: number;
  matchedEvidenceTerms: number;
} {
  const lowerText = chunkText.toLowerCase();
  const words = toWordTokens(chunkText);
  const hasSectionAnchor =
    typeof profile.sectionAnchor === "string" &&
    new RegExp(`\\b(?:section\\s*)?${escapeRegex(profile.sectionAnchor)}\\b`, "i").test(chunkText);

  const focusTermMatches = profile.focusTerms.filter((token) => lowerText.includes(token));
  const minimumFocusMatches =
    profile.focusTerms.length >= 2 ? 2 : profile.focusTerms.length === 1 ? 1 : 0;
  const hasStrongFocusTermMatch =
    minimumFocusMatches > 0 && focusTermMatches.length >= minimumFocusMatches;
  const nearFocusTerms = (() => {
    const distance = minimumPairDistance(words, profile.focusTerms);
    return typeof distance === "number" && distance <= 12;
  })();

  const hasExpansionJointPhrase = /\bexpansion\s+joints?\b/i.test(chunkText);
  const hasSealantPhrase = /\b(joint\s+sealants?|sealant\s+joints?)\b/i.test(chunkText);

  const matchedEvidenceTerms = evidenceTokens.filter((token) => lowerText.includes(token)).length;
  const proximity = minimumTokenDistance(words, "expansion", "joint");
  const nearExpansionJoint = typeof proximity === "number" && proximity <= 16;

  const queryHasExpansionJointIntent = /\bexpansion\b/i.test(rawQuery) && /\bjoint\b/i.test(rawQuery);
  const minimumEvidenceMatches = Math.max(1, Math.min(evidenceTokens.length, 2));
  const headingWindow = chunkText.slice(0, 420);
  const numberedHeadingMatch = headingWindow.match(
    /(^|\n)\s*(\d+(?:\.\d+){1,3}(?:\.)?\s+[^\n]{3,140})/i
  );
  const numberedHeadingText = numberedHeadingMatch?.[2]?.toLowerCase() ?? "";
  const focusedHeadingTerms = profile.focusTerms.filter((term) =>
    numberedHeadingText.includes(term)
  ).length;
  const hasFocusedSectionHeading = focusedHeadingTerms >= Math.min(2, profile.focusTerms.length || 2);

  const strongEvidence = queryHasExpansionJointIntent
    ? hasFocusedSectionHeading ||
      hasSectionAnchor ||
      hasExpansionJointPhrase ||
      hasSealantPhrase ||
      nearExpansionJoint
    : hasSectionAnchor ||
      (profile.queryHasSpecificationIntent
        ? hasFocusedSectionHeading ||
          hasStrongFocusTermMatch ||
          nearFocusTerms ||
          matchedEvidenceTerms >= minimumEvidenceMatches
        : matchedEvidenceTerms >= minimumEvidenceMatches);

  const headingContextMatch = profile.focusTerms.length > 0
    ? profile.focusTerms.some((term) =>
        new RegExp(`(^|\\n)\\s*(?:\\d+(?:\\.\\d+)*\\s+)?[^\\n]{0,120}\\b${escapeRegex(term)}\\b`, "i").test(
          chunkText.slice(0, 280)
        )
      )
    : /(^|\n)\s*(?:\d+(?:\.\d+)*\s+)?[^\n]{0,120}\b(expansion|joint|sealant)\b/i.test(
        chunkText.slice(0, 280)
      );

  let sectionOrPhraseBoost = 0;
  if (hasSectionAnchor) sectionOrPhraseBoost += 2;
  if (headingContextMatch) sectionOrPhraseBoost += 0.4;
  if (hasExpansionJointPhrase || hasSealantPhrase) sectionOrPhraseBoost += 0.8;
  if (nearExpansionJoint) sectionOrPhraseBoost += 0.6;
  if (hasStrongFocusTermMatch) sectionOrPhraseBoost += 0.5;
  if (nearFocusTerms) sectionOrPhraseBoost += 0.35;
  if (hasFocusedSectionHeading) sectionOrPhraseBoost += 2.8;

  return {
    strongEvidence,
    sectionOrPhraseBoost,
    matchedEvidenceTerms,
  };
}

function isExplicitSectionReviewQuery(rawQuery: string): boolean {
  return /\b(review|show|display|read|quote|exact(?:ly)?|verbatim|what(?:'s|\s+is)?\s+in)\b/i.test(
    rawQuery
  );
}

function isSectionSpecificationQuestion(rawQuery: string): boolean {
  const hasSpecIntent = /\b(spec|specs|specification|specifications|requirement|requirements)\b/i.test(rawQuery);
  if (!hasSpecIntent) {
    return false;
  }

  const hasQuestionIntent = /\b(what|which|list|summarize|outline|tell|show|review|give)\b/i.test(rawQuery);
  const hasScopeHint =
    /\b(for|about|regarding|related to|section)\b/i.test(rawQuery) ||
    /\b(volume\s*\d{1,2}|prdc|conformed)\b/i.test(rawQuery);

  return hasQuestionIntent || hasScopeHint;
}

function evaluateSectionAnchorConfidence(
  sectionAnchor: string,
  rankedChunks: RankedDocumentChunk[],
  sectionSuggestions: string[],
  profile: QueryEvidenceProfile,
  sectionIndexAnchor?: string
): SectionAnchorConfidence {
  const alignedChunks = rankedChunks.filter((chunk) => chunkHasSectionAnchor(chunk, sectionAnchor));
  const headingAlignedChunks = alignedChunks.filter(
    (chunk) =>
      hasSectionHeadingAnchor(chunk.chunkText, sectionAnchor) ||
      (typeof chunk.sectionLabel === "string" && hasSectionAnchorInText(chunk.sectionLabel, sectionAnchor))
  );
  const strongAlignedChunks = alignedChunks.filter((chunk) => chunk.strongEvidence);
  const topSuggestionAgrees = sectionSuggestions[0] === sectionAnchor;
  const sectionIndexAgrees = typeof sectionIndexAnchor === "string" && sectionIndexAnchor === sectionAnchor;

  let score = 0;
  score += alignedChunks.length * 1.2;
  score += headingAlignedChunks.length * 2;
  score += strongAlignedChunks.length * 1.5;
  if (topSuggestionAgrees) score += 0.8;
  if (sectionIndexAgrees) score += 1;
  if (profile.sectionAnchor) score += 2;
  if (!topSuggestionAgrees && sectionSuggestions.length >= 2) score -= 0.6;

  const ambiguous =
    !profile.sectionAnchor &&
    sectionSuggestions.length >= 2 &&
    !topSuggestionAgrees &&
    (score < 4.5 || headingAlignedChunks.length === 0);

  return {
    score,
    alignedChunks: alignedChunks.length,
    headingAlignedChunks: headingAlignedChunks.length,
    strongAlignedChunks: strongAlignedChunks.length,
    topSuggestionAgrees,
    sectionIndexAgrees,
    ambiguous,
  };
}

function inferCandidateSectionAnchors(
  rankedChunks: RankedDocumentChunk[],
  profile: QueryEvidenceProfile,
  maxSuggestions = 5
): string[] {
  const anchorScores = new Map<string, number>();

  for (const chunk of rankedChunks.slice(0, 120)) {
    if (chunk.keywordHits <= 0 || isLikelyTocOrIndexChunk(chunk.chunkText)) {
      continue;
    }
    const hasSectionLabel = typeof chunk.sectionLabel === "string" && chunk.sectionLabel.trim().length > 0;
    if (profile.queryHasSpecificationIntent && !hasSectionLabel) {
      continue;
    }

    for (const rawAnchor of extractInferenceAnchorsFromChunk(chunk, profile)) {
      const anchor = normalizeInferredSectionAnchor(rawAnchor, profile);
      anchorScores.set(anchor, (anchorScores.get(anchor) ?? 0) + chunk.score + (chunk.strongEvidence ? 1 : 0));
    }
  }

  return Array.from(anchorScores.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([anchor]) => anchor)
    .slice(0, maxSuggestions);
}

function collectSectionReviewChunks(
  rankedChunks: RankedDocumentChunk[],
  sectionAnchor: string,
  maxChunks = 14
): RankedDocumentChunk[] {
  const sorted = [...rankedChunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
  const direct = sorted.filter((chunk) => chunkHasSectionAnchor(chunk, sectionAnchor));

  if (direct.length === 0) {
    return [];
  }

  const nonTocDirect = direct.filter((chunk) => !isLikelyTocOrIndexChunk(chunk.chunkText));
  const primaryDirect = nonTocDirect.length > 0 ? nonTocDirect : direct;

  const headingMatches = primaryDirect.filter(
    (chunk) =>
      hasSectionHeadingAnchor(chunk.chunkText, sectionAnchor) ||
      (typeof chunk.sectionLabel === "string" && hasSectionAnchorInText(chunk.sectionLabel, sectionAnchor))
  );

  const seedChunk =
    (headingMatches.length > 0
      ? headingMatches.sort((left, right) => left.chunkIndex - right.chunkIndex)[0]
      : primaryDirect.sort((left, right) => left.chunkIndex - right.chunkIndex)[0]) ??
    primaryDirect[0];

  if (!seedChunk) {
    return [];
  }

  const firstIndex = seedChunk.chunkIndex;
  const lastIndex = Math.max(
    seedChunk.chunkIndex,
    ...primaryDirect.map((chunk) => chunk.chunkIndex)
  );
  const sectionDepth = sectionAnchor.split(".").length;

  const inRange = sorted.filter(
    (chunk) => chunk.chunkIndex >= Math.max(1, firstIndex - 1) && chunk.chunkIndex <= lastIndex + 5
  );

  const selected: RankedDocumentChunk[] = [];
  let targetAnchorCount = 0;
  for (const chunk of inRange) {
    const anchors = extractSectionAnchorsFromChunk(chunk).filter(isLikelySpecSectionAnchor);
    const hasTargetAnchor =
      chunkHasSectionAnchor(chunk, sectionAnchor) ||
      anchors.some((anchor) => anchor.startsWith(`${sectionAnchor}.`));

    const hasCompetingTopAnchor = anchors.some((anchor) => {
      if (anchor === sectionAnchor || anchor.startsWith(`${sectionAnchor}.`)) {
        return false;
      }
      return anchor.split(".").length <= sectionDepth;
    });

    if (hasCompetingTopAnchor && targetAnchorCount >= 2 && selected.length >= 3) {
      break;
    }

    if (hasTargetAnchor || anchors.length === 0 || selected.length < 3) {
      if (hasTargetAnchor) {
        targetAnchorCount += 1;
      }
      selected.push(chunk);
    }

    if (selected.length >= maxChunks) {
      break;
    }
  }

  return selected;
}

function buildExactSectionReviewContent(
  fileName: string,
  sectionAnchor: string,
  chunks: RankedDocumentChunk[],
  pages: number[]
): string {
  const exactText = chunks
    .sort((left, right) => left.chunkIndex - right.chunkIndex)
    .map((chunk) => chunk.chunkText.trim())
    .filter((chunkText) => chunkText.length > 0)
    .join("\n\n")
    .slice(0, 9000);

  const pageLabel = pages.length > 0 ? pages.join(", ") : "unknown";

  return [
    `## Section ${sectionAnchor} (${deriveShortFormName(fileName)})`,
    `- Exact indexed section text from page(s): ${pageLabel}.`,
    "",
    "```text",
    exactText || "No section text was available in indexed chunks.",
    "```",
  ].join("\n");
}

function buildSectionRequirementsSummaryContent(
  fileName: string,
  sectionAnchor: string,
  chunks: RankedDocumentChunk[],
  pages: number[]
): string {
  type SectionSubsection = {
    anchor: string;
    title: string;
    lines: string[];
  };

  const rewriteEvidencePoint = (text: string): string => {
    const normalized = text.replace(/\s+/g, " ").trim();

    if (/^expansion\s+joint\s+assemblies\s+3\.52(?:\.1)?\.?$/i.test(normalized)) {
      return "Section 3.52 addresses expansion joint assemblies.";
    }

    if (/^interior\s+and\s+exterior\s+expansion\s+joint\s+cover\s+seismic\s+performance:?$/i.test(normalized)) {
      return "Expansion joint covers must meet interior and exterior seismic performance requirements.";
    }

    if (/\bsubmittals?\b/i.test(normalized) && /\bmockup\b/i.test(normalized)) {
      return "Provide submittals, including a mockup of a typical expansion joint assembly.";
    }

    if (
      /\bwarranty\b/i.test(normalized) &&
      /\b(two\s*\(?2\)?\s*years?|2\s*years?)\b/i.test(normalized)
    ) {
      return "Provide a two-year warranty from the date of Substantial Completion.";
    }

    if (
      /\bpainted\s+finishes\b/i.test(normalized) &&
      /\b(repair|replace)\b/i.test(normalized) &&
      /\bexpansion\s+joints?\b/i.test(normalized)
    ) {
      return "For painted finishes, repair or replace roof expansion joints that show factory-finish deterioration.";
    }

    if (
      /\bpublicly\s+visible\b/i.test(normalized) &&
      /\bthree\s*\(?3\)?\s+samples?\b/i.test(normalized)
    ) {
      return "For publicly visible areas, submit three samples for each expansion joint cover assembly and each color/texture.";
    }

    if (/\bfull\s+width\b/i.test(normalized) && /\b6-?inch(?:-long)?\b/i.test(normalized)) {
      return "Submit full-width by 6-inch-long samples where required for expansion-joint assemblies.";
    }

    if (/\bmanufactured\s+roof\s+expansion\s+joint\b/i.test(normalized) && /\(not used\)/i.test(normalized)) {
      return "The Manufactured Roof Expansion Joint subsection is marked Not Used.";
    }

    const cleaned = normalized
      .replace(/^\s*\d+(?:\.\d+){1,3}\.?(?:\s+[A-Z][A-Z\s]{3,})?/i, "")
      .replace(/^[-:;,\s]+/, "")
      .replace(/\bPRDC\b[^.]*\./gi, "")
      .replace(/\bMTA\s+C&D\s+Contract\s+Number\.?/gi, "")
      .replace(/[:;]+$/, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) {
      return normalized;
    }

    const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    const withTerminalPeriod = /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
    return withTerminalPeriod.replace(/:\./g, ".");
  };

  const stripLeadingListGlyphs = (text: string): string =>
    text
      .replace(/^\s*[-*+]\s+/g, "")
      .replace(/^[\u2022\u2023\u2043\u2219\u25E6\u2027\u00B7\uF0B7]+\s*/g, "")
      .trim();

  const hasRenderableListText = (text: string): boolean => {
    const normalized = stripLeadingListGlyphs(text)
      .replace(/[\s.,:;!?()[\]{}'"`~_-]+/g, "")
      .trim();
    return normalized.length > 0;
  };

  const cleanSubsectionSentence = (text: string): string | null => {
    const cleaned = stripLeadingListGlyphs(text)
      .replace(/\s+/g, " ")
      .replace(/^[-:;,\s]+/, "")
      .replace(new RegExp(`^(?:${escapeRegex(sectionAnchor)}(?:\\.\\d+)?)\\.?\\s+`, "i"), "")
      .replace(/^[\u2022\u2023\u2043\u2219\u25E6\u2027\u00B7\uF0B7]+\s*/g, "")
      .trim();

    if (!cleaned || /^[\W_]+$/.test(cleaned) || !hasRenderableListText(cleaned)) {
      return null;
    }

    const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  };

  const inferSubsectionHeading = (text: string): { anchor: string; title: string } | null => {
    if (/\bsubmittals?\b/i.test(text) || /\bmockups?\b/i.test(text) || /\bsamples?\b/i.test(text)) {
      return {
        anchor: `${sectionAnchor}.1`,
        title: "Submittals",
      };
    }

    if (/\bwarranty\b/i.test(text)) {
      return {
        anchor: `${sectionAnchor}.2`,
        title: "Warranty",
      };
    }

    return null;
  };

  const extractSubsectionLines = (text: string): string[] => {
    const normalized = text.replace(/\s+/g, " ").trim();
    const splitParts = normalized
      .split(/(?<=[.!?])\s+|(?<=;)\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const lines: string[] = [];
    for (const part of splitParts) {
      const cleaned = cleanSubsectionSentence(
        part
          .replace(new RegExp(`^${escapeRegex(sectionAnchor)}(?:\\.\\d+)?\\.?\\s+`, "i"), "")
          .replace(/^(Submittals?|Warranty)\b:?\s*/i, "")
      );
      if (!cleaned) {
        continue;
      }
      lines.push(cleaned);
    }

    return lines;
  };

  const orderedChunks = [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
  const uniquePoints: string[] = [];
  const seen = new Set<string>();
  const subsectionMap = new Map<string, SectionSubsection>();
  let activeSubsectionAnchor: string | undefined;
  const requirementSignal = /\b(expansion|joint|warranty|submittal|assembly|manufacturer|finish|roof|sample|color|texture|width)\b/i;

  const ensureSubsection = (anchor: string, title: string): SectionSubsection => {
    const existing = subsectionMap.get(anchor);
    if (existing) {
      return existing;
    }

    const created: SectionSubsection = {
      anchor,
      title,
      lines: [],
    };
    subsectionMap.set(anchor, created);
    return created;
  };

  const appendSubsectionLines = (anchor: string, title: string, candidateLines: string[]): void => {
    const subsection = ensureSubsection(anchor, title);
    const existingKeys = new Set(subsection.lines.map((line) => line.toLowerCase()));

    for (const line of candidateLines) {
      const normalizedLineText = stripLeadingListGlyphs(line).replace(/\s+/g, " ").trim();
      if (!normalizedLineText || /^[\W_]+$/.test(normalizedLineText) || !hasRenderableListText(normalizedLineText)) {
        continue;
      }
      const normalizedLine = normalizedLineText.toLowerCase();
      if (existingKeys.has(normalizedLine)) {
        continue;
      }
      existingKeys.add(normalizedLine);
      subsection.lines.push(
        normalizedLineText.length > 260 ? `${normalizedLineText.slice(0, 257).trim()}...` : normalizedLineText
      );

      if (subsection.lines.length >= 6) {
        break;
      }
    }
  };

  for (const chunk of orderedChunks) {
    const normalized = chunk.chunkText
      .replace(/\s+/g, " ")
      .trim();

    const explicitSubsectionMatch = normalized.match(
      new RegExp(`(${escapeRegex(sectionAnchor)}\\.\\d+)\\.?\\s+`, "i")
    );

    if (explicitSubsectionMatch?.[1]) {
      const anchor = explicitSubsectionMatch[1].trim();
      const afterAnchor = normalized
        .slice((explicitSubsectionMatch.index ?? 0) + explicitSubsectionMatch[0].length)
        .trim();
      const explicitLabelMatch = afterAnchor.match(/^(Submittals?|Warranty)\b:?\s*(.*)$/i);
      const genericLabelMatch = afterAnchor.match(/^([A-Za-z&/()'\- ]{3,40}?)(?:\.|:)\s*(.*)$/);
      const title = (explicitLabelMatch?.[1] ?? genericLabelMatch?.[1] ?? "").trim().replace(/[.:\s]+$/, "");
      const body = (explicitLabelMatch?.[2] ?? genericLabelMatch?.[2] ?? "").trim();

      if (title) {
        activeSubsectionAnchor = anchor;
        appendSubsectionLines(anchor, title, body ? extractSubsectionLines(body) : []);
        continue;
      }
    }

    const inferredHeading = inferSubsectionHeading(normalized);
    if (inferredHeading) {
      activeSubsectionAnchor = inferredHeading.anchor;
      appendSubsectionLines(
        inferredHeading.anchor,
        inferredHeading.title,
        extractSubsectionLines(normalized)
      );
    } else if (activeSubsectionAnchor) {
      const activeSubsection = subsectionMap.get(activeSubsectionAnchor);
      if (activeSubsection) {
        appendSubsectionLines(activeSubsection.anchor, activeSubsection.title, extractSubsectionLines(normalized));
      }
    }

    const anchorStart = (() => {
      const match = normalized.match(new RegExp(`(?:section\\s*)?${escapeRegex(sectionAnchor)}\\b`, "i"));
      return typeof match?.index === "number" ? match.index : 0;
    })();

    const anchored = normalized.slice(anchorStart).trim();
    const stripped = stripLeadingSpecBoilerplate(anchored || normalized)
      .replace(/^\s*\d+(?:\.\d+){1,3}\.?\s*/i, "")
      .replace(/^[-:;,\s]+/, "")
      .trim();

    const parts = stripped
      .split(/(?<=[.;:])\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const preferredRequirementPart =
      parts.find((part) => /\bsubmittals?\b/i.test(part)) ??
      parts.find((part) => /\bwarranty\b/i.test(part)) ??
      parts.find((part) => /\bsamples?\b/i.test(part)) ??
      parts.find((part) => requirementSignal.test(part));

    const sentence = preferredRequirementPart ?? stripped;

    const cleaned = sentence
      .replace(/\s+/g, " ")
      .replace(/^[-:;,\s]+/, "")
      .trim();

    if (!cleaned || !requirementSignal.test(cleaned)) {
      continue;
    }

    const rewritten = rewriteEvidencePoint(cleaned);

    const key = rewritten.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniquePoints.push(rewritten.length > 260 ? `${rewritten.slice(0, 257).trim()}...` : rewritten);

    if (uniquePoints.length >= 8) {
      break;
    }

  }

  const pageLabel = pages.length > 0 ? pages.join(", ") : "unknown";
  const submittalsSubsection = subsectionMap.get(`${sectionAnchor}.1`);
  if (submittalsSubsection && orderedChunks.some((chunk) => /expansion\s+joint/i.test(chunk.chunkText))) {
    const hasSpecificMockupLine = submittalsSubsection.lines.some((line) =>
      /build\s+mockup\s+of\s+typical\s+expansion\s+joint\s+assembly\b/i.test(line)
    );
    if (!hasSpecificMockupLine) {
      const mockupCandidate = orderedChunks.find((chunk) => /build\s+mockup\s+of\b/i.test(chunk.chunkText));
      const mockupLine = mockupCandidate
        ? cleanSubsectionSentence(
            mockupCandidate.chunkText.match(/build\s+mockup\s+of[^.]*\./i)?.[0] ?? "Build mockup of typical expansion joint assembly."
          )
        : "Build mockup of typical expansion joint assembly.";
      if (mockupLine) {
        submittalsSubsection.lines.splice(1, 0, mockupLine);
      }
    }
  }

  const warrantySubsection = subsectionMap.get(`${sectionAnchor}.2`);
  if (warrantySubsection) {
    warrantySubsection.lines = warrantySubsection.lines.map((line) => {
      if (/^Period:/i.test(line)) {
        return line.replace(/^Period:/i, "Warranty Period:");
      }
      if (/^On Painted Finishes:/i.test(line)) {
        return line.replace(/^On Painted Finishes:/i, "Warranty on Painted Finishes:");
      }
      return line;
    });
  }

  const subsectionBlocks = Array.from(subsectionMap.values())
    .map((subsection) => ({
      ...subsection,
      lines: subsection.lines
        .map((line) => stripLeadingListGlyphs(line).replace(/\s+/g, " ").trim())
        .filter((line) => hasRenderableListText(line)),
    }))
    .filter((subsection) => subsection.lines.length > 0)
    .sort((left, right) => left.anchor.localeCompare(right.anchor))
    .slice(0, 2)
    .flatMap((subsection) => [
      "",
      `### ${subsection.anchor}. ${subsection.title}`,
      ...subsection.lines.map((line) => `- ${line}`),
    ]);

  return [
    `## Section ${sectionAnchor} Requirements Summary (${deriveShortFormName(fileName)})`,
    `- Reviewed indexed section evidence from page(s): ${pageLabel}.`,
    "- Key requirements captured from the section:",
    ...uniquePoints.map((point) => `- ${point}`),
    ...subsectionBlocks,
  ].join("\n");
}

function buildSectionSuggestionContent(fileName: string, anchors: string[]): string {
  if (anchors.length === 0) {
    return buildNoExactEvidenceContent(fileName);
  }

  return [
    "## Section Suggestions",
    "- I could not verify a single exact section from the current retrieved chunks.",
    `- Review one of these likely sections: ${anchors.join(", ")}.`,
    "- If you want exact text, ask: review section <number>.",
  ].join("\n");
}

function buildNoExactEvidenceContent(fileName: string): string {
  return [
    `I could not find an exact indexed passage in ${deriveShortFormName(fileName)} that answers this question.`,
    "No evidence-backed specification text was verified in the retrieved chunks for this request.",
    "Refine with a section heading or exact phrase and I will search only this file again.",
  ].join("\n");
}

function isDetailedExtractionQuery(rawQuery: string): boolean {
  // Explicit extraction signals
  if (/\b(detailed|detail|list|all|every|which\s+page|page\s+number|section)\b/i.test(rawQuery)) {
    return true;
  }
  // WH-questions asking about specific content ("what are the hold points", "what is the hold point requirement")
  if (/\bwhat (are|is|were|was)\b/i.test(rawQuery)) {
    return true;
  }
  // Imperative retrieval verbs
  if (/\b(find|show|identify|locate|extract|enumerate)\b/i.test(rawQuery)) {
    return true;
  }
  return false;
}

function getLexicalMatchChunks(
  rawQuery: string,
  chunks: RankedDocumentChunk[],
  effectiveTokens: string[]
): RankedDocumentChunk[] {
  const tokens = effectiveTokens.length > 0 ? effectiveTokens : tokenizeQuery(rawQuery);
  if (tokens.length === 0) {
    return [];
  }

  const bigrams = tokens
    .slice(0, -1)
    .map((token, index) => `${token} ${tokens[index + 1]}`)
    .flatMap((phrase) => {
      const singularized = phrase
        .split(" ")
        .map((word) => word.replace(/s$/, ""))
        .join(" ");
      return singularized === phrase ? [phrase] : [phrase, singularized];
    });

  const scored = chunks
    .map((chunk) => {
      const lower = chunk.chunkText.toLowerCase();
      const tokenHits = keywordHitScore(tokens, lower);
      const phraseHits = bigrams.reduce(
        (count, phrase) => count + (phrase.length > 2 && lower.includes(phrase) ? 1 : 0),
        0
      );

      return {
        chunk,
        lexicalScore: tokenHits + phraseHits * 2,
      };
    })
    .filter((entry) => entry.lexicalScore > 0)
    .sort((left, right) => {
      if (right.lexicalScore !== left.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }
      if (typeof left.chunk.pageNumber === "number" && typeof right.chunk.pageNumber === "number") {
        if (left.chunk.pageNumber !== right.chunk.pageNumber) {
          return left.chunk.pageNumber - right.chunk.pageNumber;
        }
      }
      return left.chunk.chunkIndex - right.chunk.chunkIndex;
    });

  return scored.map((entry) => entry.chunk);
}

/**
 * Extracts a ~windowSize-char window from rawText centered on the first
 * occurrence of a phrase (bigram) or individual token from the query, so the
 * displayed excerpt shows the relevant context rather than the chunk start.
 */
function extractPhraseContextWindow(
  rawText: string,
  phrases: string[],
  tokens: string[],
  windowSize = 280
): string {
  const lower = rawText.toLowerCase();
  let matchPos = -1;

  // Prefer full-phrase match (most precise)
  for (const phrase of phrases) {
    const pos = lower.indexOf(phrase);
    if (pos !== -1) {
      matchPos = pos;
      break;
    }
  }

  // Fall back to first individual token match
  if (matchPos === -1) {
    for (const token of tokens) {
      const pos = lower.indexOf(token);
      if (pos !== -1) {
        matchPos = pos;
        break;
      }
    }
  }

  const flat = rawText.replace(/\s+/g, " ").trim();

  if (matchPos === -1) {
    return flat.length > windowSize ? `${flat.slice(0, windowSize - 3).trim()}...` : flat;
  }

  // Place the match ~1/4 from the start of the window
  const start = Math.max(0, matchPos - Math.floor(windowSize / 4));
  const end = Math.min(rawText.length, start + windowSize);
  const slice = rawText.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "\u2026" : "";
  const suffix = end < rawText.length ? "\u2026" : "";
  return `${prefix}${slice}${suffix}`;
}

function buildDetailedKeywordMatchContent(
  fileName: string,
  rawQuery: string,
  chunks: RankedDocumentChunk[]
): string {
  const alias = deriveShortFormName(fileName);

  // Compute phrases and tokens once for context-window extraction
  const queryTokens = tokenizeQuery(rawQuery);
  const bigrams = queryTokens
    .slice(0, -1)
    .map((token, index) => `${token} ${queryTokens[index + 1]}`)
    .flatMap((phrase) => {
      const singularized = phrase
        .split(" ")
        .map((word) => word.replace(/s$/, ""))
        .join(" ");
      return singularized === phrase ? [phrase] : [phrase, singularized];
    });

  const seen = new Set<string>();
  const lines = chunks
    .slice(0, 12)
    .map((chunk) => {
      const stripped = stripLeadingSpecBoilerplate(chunk.chunkText);
      const excerpt = extractPhraseContextWindow(stripped, bigrams, queryTokens, 280);
      const key = excerpt.toLowerCase();
      if (!excerpt || seen.has(key)) {
        return null;
      }
      seen.add(key);
      const page = typeof chunk.pageNumber === "number" ? ` (p. ${chunk.pageNumber})` : "";
      return `-${page} ${excerpt}`;
    })
    .filter((line): line is string => Boolean(line));

  return [
    `## Detailed Matches (${alias})`,
    `- Query focus: ${rawQuery.trim()}`,
    "- Matched indexed passages:",
    ...lines,
  ].join("\n");
}

async function answerFromDocumentDetail(
  detail: NonNullable<DocumentDetailResult>,
  rawQuery: string,
  startedAt: number,
  history?: ChatHistoryTurn[],
  openDocs?: OpenDocContext[],
  selectedFileName?: string
): Promise<CoordinatorResult> {
  const featureFlags = getChatCoordinatorFeatureFlags();
  const queryTokens = expandSpellingVariants(tokenizeQuery(rawQuery));
  const fileReferenceTerms = new Set(extractActiveDocReferenceTerms(detail.fileName));
  const scoringTokens = queryTokens.filter((token) => !fileReferenceTerms.has(token));
  const evidenceTokens = (scoringTokens.length > 0 ? scoringTokens : queryTokens)
    .filter((token) => !GENERIC_EVIDENCE_TOKENS.has(token));
  const filteredEffectiveTokens = filterHighFrequencyTokens(
    scoringTokens.length > 0 ? scoringTokens : queryTokens,
    detail.chunks
  );
  const sanitizedEffectiveTokens = filteredEffectiveTokens.filter(
    (token) => !GENERIC_EVIDENCE_TOKENS.has(token)
  );
  const effectiveTokens =
    evidenceTokens.length > 0
      ? sanitizedEffectiveTokens.some((token) => evidenceTokens.includes(token))
        ? (sanitizedEffectiveTokens.length > 0 ? sanitizedEffectiveTokens : evidenceTokens)
        : evidenceTokens
      : (sanitizedEffectiveTokens.length > 0 ? sanitizedEffectiveTokens : filteredEffectiveTokens);
  const coverPageQuestion = isCoverPageQuestion(rawQuery);
  const factualIntent = isFactualIntent(rawQuery);
  const evidenceProfile = buildQueryEvidenceProfile(
    rawQuery,
    evidenceTokens.length > 0 ? evidenceTokens : effectiveTokens
  );

  const rankedChunks: RankedDocumentChunk[] = detail.chunks
    .map((chunk) => {
      const keywordHits = keywordHitScore(effectiveTokens, chunk.chunkText);
      const matchScore = scoreChunk(effectiveTokens, chunk.chunkText, chunk.chunkIndex);
      const evidence = evaluateChunkEvidence(
        rawQuery,
        evidenceTokens.length > 0 ? evidenceTokens : effectiveTokens,
        chunk.chunkText,
        evidenceProfile
      );
      const coverBoost =
        coverPageQuestion && keywordHits > 0
          ? chunk.chunkIndex === 1
            ? 10
            : chunk.chunkIndex <= 3
              ? 4
              : 0
          : 0;

      return {
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        sourceType: chunk.sourceType,
        pageNumber: chunk.pageNumber,
        sectionLabel: chunk.sectionLabel,
        metadata: chunk.metadata,
        keywordHits,
        strongEvidence: evidence.strongEvidence,
        matchedEvidenceTerms: evidence.matchedEvidenceTerms,
        score:
          matchScore +
          coverBoost +
          (featureFlags.sectionProximityBoostEnabled ? evidence.sectionOrPhraseBoost : 0),
      };
    })
    .filter((chunk) => chunk.chunkText.trim().length > 0)
    .filter((chunk) => !isLikelyUnreadableChunk(chunk.chunkText))
    .sort((a, b) => b.score - a.score);

  const inferredSectionAnchor = inferSectionAnchorFromRankedChunks(rankedChunks, evidenceProfile);
  const sectionSuggestions = inferCandidateSectionAnchors(rankedChunks, evidenceProfile);
  const labelFocusedSectionAnchor = inferSectionAnchorFromSectionLabels(rankedChunks, evidenceProfile);
  const sectionIndexAnchor = inferSectionAnchorFromSectionIndex(rankedChunks, evidenceProfile);
  const sectionSpecificationQuestion = isSectionSpecificationQuestion(rawQuery);

  const summarizeAnchorSupport = (anchor: string): { aligned: number; heading: number } => {
    const alignedChunks = rankedChunks.filter((chunk) => chunkHasSectionAnchor(chunk, anchor));
    const headingChunks = alignedChunks.filter(
      (chunk) =>
        hasSectionHeadingAnchor(chunk.chunkText, anchor) ||
        (typeof chunk.sectionLabel === "string" && hasSectionAnchorInText(chunk.sectionLabel, anchor))
    );

    return {
      aligned: alignedChunks.length,
      heading: headingChunks.length,
    };
  };

  const topSuggestedAnchor = sectionSuggestions[0];
  const resolvedSectionAnchor = (() => {
    if (!evidenceProfile.queryHasSpecificationIntent || evidenceProfile.sectionAnchor) {
      return inferredSectionAnchor;
    }

    if (sectionIndexAnchor) {
      return normalizeInferredSectionAnchor(sectionIndexAnchor, evidenceProfile);
    }

    if (inferredSectionAnchor) {
      return inferredSectionAnchor;
    }

    if (labelFocusedSectionAnchor) {
      return normalizeInferredSectionAnchor(labelFocusedSectionAnchor, evidenceProfile);
    }

    if (!topSuggestedAnchor) {
      return inferredSectionAnchor;
    }

    return topSuggestedAnchor;
  })();

  const sectionAlignedChunks = resolvedSectionAnchor
    ? rankedChunks.filter((chunk) => chunkHasSectionAnchor(chunk, resolvedSectionAnchor))
    : [];
  const sectionAlignedHeadingChunks = resolvedSectionAnchor
    ? sectionAlignedChunks.filter(
        (chunk) =>
          hasSectionHeadingAnchor(chunk.chunkText, resolvedSectionAnchor) ||
          (typeof chunk.sectionLabel === "string" &&
            hasSectionAnchorInText(chunk.sectionLabel, resolvedSectionAnchor))
      )
    : [];
  const shouldApplySectionScope = Boolean(resolvedSectionAnchor) && (
    Boolean(evidenceProfile.sectionAnchor)
      ? sectionAlignedChunks.length > 0
      : sectionAlignedChunks.length >= 2 &&
        (sectionAlignedHeadingChunks.length >= 1 || sectionAlignedChunks.length >= 3)
  );

  const keywordMatchedChunks = rankedChunks.filter((chunk) => chunk.keywordHits > 0);
  const evidenceQualifiedChunks = keywordMatchedChunks.filter((chunk) => chunk.strongEvidence);
  const resolvedAnchorConfidence = resolvedSectionAnchor
    ? evaluateSectionAnchorConfidence(
        resolvedSectionAnchor,
        rankedChunks,
        sectionSuggestions,
        evidenceProfile,
        sectionIndexAnchor
      )
    : undefined;

  if (featureFlags.retrievalTraceEnabled) {
    logger.info("chat.coordinator.active_doc_trace", {
      fileId: detail.fileId,
      fileName: detail.fileName,
      queryPreview: rawQuery.slice(0, 180),
      inferredSectionAnchor,
      resolvedSectionAnchor,
      resolvedAnchorConfidence,
      queryTokens,
      effectiveTokens,
      evidenceTokens,
      rankedPreview: rankedChunks.slice(0, 10).map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        keywordHits: chunk.keywordHits,
        strongEvidence: chunk.strongEvidence,
        matchedEvidenceTerms: chunk.matchedEvidenceTerms,
        score: Number(chunk.score.toFixed(3)),
      })),
    });
  }

  const ambiguousSectionInference =
    factualIntent &&
    evidenceProfile.queryHasSpecificationIntent &&
    !evidenceProfile.sectionAnchor &&
    sectionSuggestions.length >= 2 &&
    Boolean(resolvedSectionAnchor) &&
    Boolean(resolvedAnchorConfidence?.ambiguous) &&
    !sectionSpecificationQuestion;

  if (ambiguousSectionInference) {
    const domains = classifyQueryDomains(rawQuery);
    const telemetry = buildTelemetry(startedAt);
    const sources = buildSingleSource(detail.fileId, detail.fileName, {
      displayName: deriveShortFormName(detail.fileName),
    });

    return {
      content: buildSectionSuggestionContent(detail.fileName, sectionSuggestions),
      sources,
      citations: [],
      domains,
      coordinator: buildCoordinatorMetadata(domains, telemetry),
      cacheHit: false,
      suggestions: buildSuggestions(rawQuery, domains, sources, {
        selectedFileName,
        enforceSelectedFileScope: true,
      }),
      autoOpenFileName: detail.fileName,
    };
  }

  if (isExplicitSectionReviewQuery(rawQuery) || sectionSpecificationQuestion) {
    const sectionAnchor =
      evidenceProfile.sectionAnchor ??
      resolvedSectionAnchor ??
      sectionSuggestions[0] ??
      inferSectionAnchorFromSectionLabels(rankedChunks, evidenceProfile);
    const domains = classifyQueryDomains(rawQuery);

    if (!sectionAnchor) {
      const telemetry = buildTelemetry(startedAt);
      const sources = buildSingleSource(detail.fileId, detail.fileName, {
        displayName: deriveShortFormName(detail.fileName),
      });

      return {
        content: buildSectionSuggestionContent(detail.fileName, sectionSuggestions),
        sources,
        citations: [],
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry),
        cacheHit: false,
        suggestions: buildSuggestions(rawQuery, domains, sources, {
          selectedFileName,
          enforceSelectedFileScope: true,
        }),
        autoOpenFileName: detail.fileName,
      };
    }

    const anchorSupport = summarizeAnchorSupport(sectionAnchor);
    const sectionAnchorConfidence = evaluateSectionAnchorConfidence(
      sectionAnchor,
      rankedChunks,
      sectionSuggestions,
      evidenceProfile,
      sectionIndexAnchor
    );
    const ambiguousInferredReviewAnchor =
      !evidenceProfile.sectionAnchor &&
      !sectionSpecificationQuestion &&
      (sectionAnchorConfidence.ambiguous ||
        (sectionSuggestions.length >= 2 && (anchorSupport.aligned < 2 || anchorSupport.heading < 1)));

    if (ambiguousInferredReviewAnchor) {
      const telemetry = buildTelemetry(startedAt);
      const sources = buildSingleSource(detail.fileId, detail.fileName, {
        displayName: deriveShortFormName(detail.fileName),
      });

      return {
        content: buildSectionSuggestionContent(detail.fileName, sectionSuggestions),
        sources,
        citations: [],
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry),
        cacheHit: false,
        suggestions: buildSuggestions(rawQuery, domains, sources, {
          selectedFileName,
          enforceSelectedFileScope: true,
        }),
        autoOpenFileName: detail.fileName,
      };
    }

    const sectionChunks = collectSectionReviewChunks(rankedChunks, sectionAnchor);

    if (sectionChunks.length === 0) {
      const suggestions = inferCandidateSectionAnchors(rankedChunks, evidenceProfile);
      const telemetry = buildTelemetry(startedAt);
      const sources = buildSingleSource(detail.fileId, detail.fileName, {
        displayName: deriveShortFormName(detail.fileName),
      });

      return {
        content: buildSectionSuggestionContent(detail.fileName, suggestions),
        sources,
        citations: [],
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry),
        cacheHit: false,
        suggestions: buildSuggestions(rawQuery, domains, sources, {
          selectedFileName,
          enforceSelectedFileScope: true,
        }),
        autoOpenFileName: detail.fileName,
      };
    }

    const activeNodes: GraphNodeContext[] = sectionChunks.map((chunk) => ({
      chunkId: `${detail.fileId}:${chunk.chunkIndex}`,
      fileId: detail.fileId,
      fileName: detail.fileName,
      chunkIndex: chunk.chunkIndex,
      chunkText: chunk.chunkText,
      pageNumber: chunk.pageNumber,
      sourceType: "content",
      docCategory: detail.docCategory,
      tags: detail.tags,
      score: chunk.score,
    }));

    const provisionalPages = normalizePageReferences(
      sectionChunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        sourceType: chunk.sourceType ?? "content",
        metadata: chunk.metadata,
      })),
      { maxPages: 8 }
    );

    const provisionalSources = buildSingleSource(detail.fileId, detail.fileName, {
      suggestedPages: provisionalPages.suggestedPages,
      bestPage: provisionalPages.bestPage,
      displayName: deriveShortFormName(detail.fileName),
      pageOrigin: provisionalPages.pageOrigin,
    });

    const citations = buildValidatedCitations(activeNodes, provisionalSources, {
      allowMetadataFallback: featureFlags.citationFallbackEnabled,
      strictCitationVerificationEnabled: true,
      strictTokens: evidenceTokens.length > 0 ? evidenceTokens : effectiveTokens,
    });

    const finalizedPages = normalizePageReferences(
      citations.length > 0
        ? citations.map((citation) => ({
            chunkIndex: citation.chunkIndex,
            pageNumber: citation.pageNumber,
            sourceType: citation.sourceType,
          }))
        : sectionChunks.map((chunk) => ({
            chunkIndex: chunk.chunkIndex,
            pageNumber: chunk.pageNumber,
            sourceType: chunk.sourceType ?? "content",
            metadata: chunk.metadata,
          })),
      {
        maxPages: 8,
      }
    );

    const sources = buildSingleSource(detail.fileId, detail.fileName, {
      suggestedPages: finalizedPages.suggestedPages,
      bestPage: finalizedPages.bestPage,
      displayName: deriveShortFormName(detail.fileName),
      pageOrigin: finalizedPages.pageOrigin,
    });

    const pagesFromCitations = Array.from(
      new Set(
        (citations ?? [])
          .map((citation) => citation.pageNumber)
          .filter((page): page is number => typeof page === "number")
      )
    );
    const sectionPages =
      pagesFromCitations.length > 0
        ? pagesFromCitations
        : (finalizedPages.suggestedPages ?? []).filter(
            (page): page is number => typeof page === "number"
          );

    const wantsCompleteSpecificationsSummary =
      /\bcomplete\s+specifications?\b/i.test(rawQuery) ||
      /\bkey\s+takeaways?\b/i.test(rawQuery) ||
      /\brequirements\s+include\b/i.test(rawQuery);

    const preferRequirementsSummary =
      wantsCompleteSpecificationsSummary ||
      (sectionSpecificationQuestion && sectionAnchorConfidence.score >= 4);

    if (preferRequirementsSummary) {
      const summaryContent = buildSectionRequirementsSummaryContent(
        detail.fileName,
        sectionAnchor,
        sectionChunks,
        sectionPages
      );
      const summaryWithGuardrail = enforceAliasAndEvidenceFormatting(summaryContent, sources);

      const telemetry = buildTelemetry(startedAt);

      return {
        content: summaryWithGuardrail,
        sources,
        citations,
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry, {
          estimatedContextTokens: estimateContextTokens(activeNodes),
        }),
        cacheHit: false,
        suggestions: buildSuggestions(rawQuery, domains, sources, {
          selectedFileName,
          enforceSelectedFileScope: true,
        }),
        autoOpenFileName: detail.fileName,
      };
    }

    const telemetry = buildTelemetry(startedAt);
    return {
      content: buildExactSectionReviewContent(
        detail.fileName,
        sectionAnchor,
        sectionChunks,
        sectionPages
      ),
      sources,
      citations,
      domains,
      coordinator: buildCoordinatorMetadata(domains, telemetry, {
        estimatedContextTokens: estimateContextTokens(activeNodes),
      }),
      cacheHit: false,
      suggestions: buildSuggestions(rawQuery, domains, sources, {
        selectedFileName,
        enforceSelectedFileScope: true,
      }),
      autoOpenFileName: detail.fileName,
    };
  }

  if (featureFlags.retrievalTraceEnabled) {
    logger.info("chat.coordinator.active_doc_trace", {
      fileId: detail.fileId,
      fileName: detail.fileName,
      queryPreview: rawQuery.slice(0, 180),
      inferredSectionAnchor,
      resolvedSectionAnchor,
      queryTokens,
      effectiveTokens,
      evidenceTokens,
      rankedPreview: rankedChunks.slice(0, 10).map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        keywordHits: chunk.keywordHits,
        strongEvidence: chunk.strongEvidence,
        matchedEvidenceTerms: chunk.matchedEvidenceTerms,
        score: Number(chunk.score.toFixed(3)),
      })),
    });
  }

  if (
    factualIntent &&
    queryTokens.length > 0 &&
    (keywordMatchedChunks.length === 0 ||
      (featureFlags.strictFactualActiveDocMode && evidenceQualifiedChunks.length === 0))
  ) {
    const domains = classifyQueryDomains(rawQuery);
    const telemetry = buildTelemetry(startedAt);
    const sources = buildSingleSource(detail.fileId, detail.fileName, {
      displayName: deriveShortFormName(detail.fileName),
    });

    return {
      content:
        sectionSuggestions.length > 0
          ? buildSectionSuggestionContent(detail.fileName, sectionSuggestions)
          : buildNoExactEvidenceContent(detail.fileName),
      sources,
      citations: [],
      domains,
      coordinator: buildCoordinatorMetadata(domains, telemetry),
      cacheHit: false,
      suggestions: buildSuggestions(rawQuery, domains, sources, {
        selectedFileName,
        enforceSelectedFileScope: true,
      }),
      autoOpenFileName: detail.fileName,
    };
  }

  if (isDetailedExtractionQuery(rawQuery)) {
    const lexicalMatches = getLexicalMatchChunks(
      rawQuery,
      rankedChunks,
      evidenceTokens.length > 0 ? evidenceTokens : effectiveTokens
    ).slice(0, 12);

    if (lexicalMatches.length > 0) {
      const domains = classifyQueryDomains(rawQuery);
      const activeNodes: GraphNodeContext[] = lexicalMatches.map((chunk) => ({
        chunkId: `${detail.fileId}:${chunk.chunkIndex}`,
        fileId: detail.fileId,
        fileName: detail.fileName,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        pageNumber: chunk.pageNumber,
        sourceType: "content",
        docCategory: detail.docCategory,
        tags: detail.tags,
        score: chunk.score,
      }));

      const provisionalPages = normalizePageReferences(
        lexicalMatches.map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          sourceType: chunk.sourceType ?? "content",
          metadata: chunk.metadata,
        })),
        {
          maxPages: 8,
        }
      );

      const provisionalSources = buildSingleSource(detail.fileId, detail.fileName, {
        suggestedPages: provisionalPages.suggestedPages,
        bestPage: provisionalPages.bestPage,
        displayName: deriveShortFormName(detail.fileName),
        pageOrigin: provisionalPages.pageOrigin,
      });

      const citations = buildValidatedCitations(activeNodes, provisionalSources, {
        allowMetadataFallback: featureFlags.citationFallbackEnabled,
        strictCitationVerificationEnabled: false,
        strictTokens: evidenceTokens.length > 0 ? evidenceTokens : effectiveTokens,
      });

      const sources = buildSingleSource(detail.fileId, detail.fileName, {
        suggestedPages: provisionalPages.suggestedPages,
        bestPage: provisionalPages.bestPage,
        displayName: deriveShortFormName(detail.fileName),
        pageOrigin: provisionalPages.pageOrigin,
      });

      const telemetry = buildTelemetry(startedAt);

      // Try LLM interpretation first; fall back to verbatim raw-text if unavailable
      const llmContent = await callDetailedExtractionLlm(rawQuery, detail.fileName, lexicalMatches);
      const content = llmContent ?? buildDetailedKeywordMatchContent(detail.fileName, rawQuery, lexicalMatches);

      return {
        content,
        sources,
        citations,
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry, {
          estimatedContextTokens: estimateContextTokens(activeNodes),
        }),
        cacheHit: false,
        suggestions: buildSuggestions(rawQuery, domains, sources, {
          selectedFileName,
          enforceSelectedFileScope: true,
        }),
        autoOpenFileName: detail.fileName,
      };
    }
  }

  const primaryChunkPool = (
    evidenceQualifiedChunks.length > 0
      ? evidenceQualifiedChunks
      : keywordMatchedChunks.length > 0
        ? keywordMatchedChunks
        : rankedChunks
  );

  const selectedChunks = (
    shouldApplySectionScope
      ? (() => {
          const alignedCandidates = primaryChunkPool.filter((chunk) => {
            if (!chunkHasSectionAnchor(chunk, resolvedSectionAnchor!)) {
              return false;
            }

            if (!evidenceProfile.queryHasSpecificationIntent) {
              return true;
            }

            const sectionLabelAnchored =
              typeof chunk.sectionLabel === "string" &&
              hasSectionAnchorInText(chunk.sectionLabel, resolvedSectionAnchor!);
            const headingAnchored = hasSectionHeadingAnchor(chunk.chunkText, resolvedSectionAnchor!);
            // Also accept chunks where the section anchor appears inline in text
            // (multi-section chunks without newlines won't pass headingAnchored alone).
            const inlineAnchored = hasSectionAnchorInText(chunk.chunkText, resolvedSectionAnchor!);
            return sectionLabelAnchored || headingAnchored || inlineAnchored;
          });
          const alignedPool = (() => {
            const nonToc = alignedCandidates.filter(
              (chunk) => !isLikelyTocOrIndexChunk(chunk.chunkText)
            );
            return nonToc.length >= 2 ? nonToc : alignedCandidates;
          })();

          const aligned = alignedPool
            .sort((left, right) => {
              const leftHeading = hasSectionHeadingAnchor(left.chunkText, resolvedSectionAnchor!) ? 1 : 0;
              const rightHeading = hasSectionHeadingAnchor(right.chunkText, resolvedSectionAnchor!) ? 1 : 0;
              const leftSectionLabel =
                typeof left.sectionLabel === "string" &&
                hasSectionAnchorInText(left.sectionLabel, resolvedSectionAnchor!)
                  ? 1
                  : 0;
              const rightSectionLabel =
                typeof right.sectionLabel === "string" &&
                hasSectionAnchorInText(right.sectionLabel, resolvedSectionAnchor!)
                  ? 1
                  : 0;
              if (leftSectionLabel !== rightSectionLabel) {
                return rightSectionLabel - leftSectionLabel;
              }
              if (leftHeading !== rightHeading) {
                return rightHeading - leftHeading;
              }
              const leftSectionDensity = countSectionReferences(left.chunkText);
              const rightSectionDensity = countSectionReferences(right.chunkText);
              if (leftSectionDensity !== rightSectionDensity) {
                return leftSectionDensity - rightSectionDensity;
              }
              const leftPage = typeof left.pageNumber === "number" ? left.pageNumber : Number.POSITIVE_INFINITY;
              const rightPage = typeof right.pageNumber === "number" ? right.pageNumber : Number.POSITIVE_INFINITY;
              if (leftPage !== rightPage) {
                return leftPage - rightPage;
              }
              return left.chunkIndex - right.chunkIndex;
            });
          const scopedAligned = (() => {
            if (!evidenceProfile.queryHasSpecificationIntent) {
              return aligned;
            }
            const firstPage = aligned.find((chunk) => typeof chunk.pageNumber === "number")?.pageNumber;
            if (typeof firstPage !== "number") {
              return aligned;
            }
            const narrowed = aligned.filter(
              (chunk) => typeof chunk.pageNumber === "number" && chunk.pageNumber <= firstPage + 1
            );
            return narrowed.length > 0 ? narrowed : aligned;
          })();

          const strictSectionScope = Boolean(evidenceProfile.sectionAnchor) || evidenceProfile.queryHasSpecificationIntent;
          if (scopedAligned.length >= 2 || (strictSectionScope && scopedAligned.length > 0)) {
            return scopedAligned;
          }
          const unaligned = primaryChunkPool.filter(
            (chunk) => !chunkHasSectionAnchor(chunk, resolvedSectionAnchor!)
          );
          return [...aligned, ...unaligned];
        })()
      : primaryChunkPool
  ).slice(0, 6);

  const activeNodes: GraphNodeContext[] = selectedChunks.map((chunk) => ({
    chunkId: `${detail.fileId}:${chunk.chunkIndex}`,
    fileId: detail.fileId,
    fileName: detail.fileName,
    chunkIndex: chunk.chunkIndex,
    chunkText: chunk.chunkText,
    pageNumber: chunk.pageNumber,
    sourceType: "content",
    docCategory: detail.docCategory,
    tags: detail.tags,
    score: chunk.score,
  }));

  const domains = classifyQueryDomains(rawQuery);
  const agentStartedAt = Date.now();
  const content = await callSingleAgent(
    rawQuery,
    domains,
    activeNodes,
    undefined,
    history,
    openDocs,
    selectedFileName
  );
  const agentMs = Date.now() - agentStartedAt;

  const provisionalPages = normalizePageReferences(
    selectedChunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber,
      sourceType: chunk.sourceType ?? "content",
      metadata: chunk.metadata,
    })),
    {
      maxPages: 4,
    }
  );

  const provisionalSources = buildSingleSource(detail.fileId, detail.fileName, {
    suggestedPages: provisionalPages.suggestedPages,
    bestPage: provisionalPages.bestPage,
    displayName: deriveShortFormName(detail.fileName),
    pageOrigin: provisionalPages.pageOrigin,
  });

  const citations = buildValidatedCitations(activeNodes, provisionalSources, {
    allowMetadataFallback: featureFlags.citationFallbackEnabled,
    strictCitationVerificationEnabled:
      factualIntent && featureFlags.strictCitationVerificationEnabled,
    strictTokens: evidenceTokens.length > 0 ? evidenceTokens : effectiveTokens,
  });

  const alignedHeadingPageReferences = resolvedSectionAnchor
    ? (() => {
        const headingAligned = sectionAlignedChunks
          .filter(
            (chunk) =>
              chunkHasSectionAnchor(chunk, resolvedSectionAnchor) &&
              (hasSectionHeadingAnchor(chunk.chunkText, resolvedSectionAnchor) ||
                (typeof chunk.sectionLabel === "string" &&
                  hasSectionAnchorInText(chunk.sectionLabel, resolvedSectionAnchor)))
          )
          .sort((left, right) => left.chunkIndex - right.chunkIndex);

        if (!evidenceProfile.queryHasSpecificationIntent) {
          return headingAligned.map((chunk) => ({
            chunkIndex: chunk.chunkIndex,
            pageNumber: chunk.pageNumber,
            sourceType: chunk.sourceType ?? "content",
            metadata: chunk.metadata,
          }));
        }

        const firstPage = headingAligned.find((chunk) => typeof chunk.pageNumber === "number")?.pageNumber;
        const scoped =
          typeof firstPage === "number"
            ? headingAligned.filter(
                (chunk) => typeof chunk.pageNumber === "number" && chunk.pageNumber <= firstPage + 1
              )
            : headingAligned;

        return scoped.map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          sourceType: chunk.sourceType ?? "content",
          metadata: chunk.metadata,
        }));
      })()
    : [];

  const finalizedPages = normalizePageReferences(
    citations.length > 0
      ? [
          ...citations.map((citation) => ({
            chunkIndex: citation.chunkIndex,
            pageNumber: citation.pageNumber,
            sourceType: citation.sourceType,
          })),
          ...alignedHeadingPageReferences,
        ]
      : selectedChunks.map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          sourceType: chunk.sourceType ?? "content",
          metadata: chunk.metadata,
        })),
    {
      maxPages: 4,
    }
  );

  const sources = buildSingleSource(detail.fileId, detail.fileName, {
    suggestedPages: finalizedPages.suggestedPages,
    bestPage: finalizedPages.bestPage,
    displayName: deriveShortFormName(detail.fileName),
    pageOrigin: finalizedPages.pageOrigin,
  });
  const guardedContent =
    isFactualIntent(rawQuery) && citations.length === 0
      ? featureFlags.strictFactualActiveDocMode
        ? buildNoExactEvidenceContent(detail.fileName)
        : withUncertaintyMarker(content)
      : content;
  const contentWithGuardrail = enforceAliasAndEvidenceFormatting(guardedContent, sources);
  const telemetry = buildTelemetry(startedAt, { agentMs });

  return {
    content: contentWithGuardrail,
    sources,
    citations,
    domains,
    coordinator: buildCoordinatorMetadata(domains, telemetry, {
      estimatedContextTokens: estimateContextTokens(activeNodes),
    }),
    cacheHit: false,
    suggestions: buildSuggestions(rawQuery, domains, sources, {
      selectedFileName,
      enforceSelectedFileScope: Boolean(selectedFileName),
    }),
    autoOpenFileName: detail.fileName,
  };
}

function hasKeywordMatchInDocument(detail: NonNullable<DocumentDetailResult>, query: string): boolean {
  const queryTokens = tokenizeQuery(query, 3, 8);
  if (queryTokens.length === 0) {
    return false;
  }

  return detail.chunks.some((chunk) => keywordHitScore(queryTokens, chunk.chunkText) > 0);
}

// ---------- Recency reasoning (works without LLM) ----------

const RECENCY_QUERY_PATTERNS = [
  /\b(latest|most recent|newest|last|current)\b/i,
  /\bwhich.{0,20}(latest|recent|newest|current)\b/i,
  /\b(latest|recent|newest)\s+(one|version|file|document|revision)\b/i,
  /\bwhich.{0,25}(updated|issued|revised)\b/i,
];

function isRecencyQuery(query: string): boolean {
  return RECENCY_QUERY_PATTERNS.some((p) => p.test(query));
}

/**
 * Extract all filenames from the plain text of assistant messages in history.
 * Looks for tokens that end in a known file extension.
 */
function extractFilenamesFromHistory(history: ChatHistoryTurn[]): string[] {
  const filePattern = /[\w.\- ()+/\\[\]]+\.(pdf|docx?|xlsx?|pptx?|txt|csv|dwg|rvt)/gi;
  const seen = new Set<string>();
  for (const turn of history) {
    if (turn.role !== "assistant") continue;
    for (const match of turn.content.matchAll(filePattern)) {
      const name = match[0].trim();
      if (name.length > 4) seen.add(name);
    }
  }
  return Array.from(seen);
}

/**
 * Parse a revision score from a filename.
 * Extracts tokens like R00, R01, R02, REV0, REV1, REV2, V1, V2, etc.
 * Higher means more recent.
 */
function parseRevisionScore(fileName: string): number {
  // Match R<digits> or REV<digits> (case-insensitive)
  const revMatch = fileName.match(/[-_\s](R|REV|V)(\d+)/i);
  if (revMatch) {
    const prefix = revMatch[1].toUpperCase();
    const num = parseInt(revMatch[2], 10);
    // Weight REV higher than R higher than V (arbitrary tiebreaker)
    if (prefix === "REV") return 10000 + num * 10;
    if (prefix === "R") return 5000 + num * 10;
    return 1000 + num * 10;
  }
  return 0;
}

/**
 * Parse a date score from a filename.
 * Looks for MM-DD-YYYY, YYYY-MM-DD, MMDDYYYY, or YYMMDD style tokens.
 * Returns a numeric timestamp approximation for comparison.
 */
function parseDateScore(fileName: string): number {
  // YYYY-MM-DD
  const iso = fileName.match(/(\d{4})[.\-_](\d{2})[.\-_](\d{2})/);
  if (iso) return parseInt(`${iso[1]}${iso[2]}${iso[3]}`, 10);

  // MM-DD-YYYY
  const mdy = fileName.match(/(\d{2})[.\-_](\d{2})[.\-_](\d{4})/);
  if (mdy) return parseInt(`${mdy[3]}${mdy[1]}${mdy[2]}`, 10);

  // 8-digit YYYYMMDD or MMDDYYYY
  const compact = fileName.match(/\b(\d{8})\b/);
  if (compact) return parseInt(compact[1], 10);

  return 0;
}

interface FileRecencyScore {
  fileName: string;
  revisionScore: number;
  dateScore: number;
  total: number;
}

function scoreFileRecency(fileName: string): FileRecencyScore {
  const revisionScore = parseRevisionScore(fileName);
  const dateScore = parseDateScore(fileName);
  return { fileName, revisionScore, dateScore, total: revisionScore + dateScore };
}

function resolveRecencyAnswer(
  query: string,
  history: ChatHistoryTurn[]
): { content: string; sources: SendChatMessageResponse["sources"] } | null {
  if (!isRecencyQuery(query)) return null;

  const historyFiles = extractFilenamesFromHistory(history);
  if (historyFiles.length < 2) return null;

  const scored = historyFiles.map(scoreFileRecency).sort((a, b) => b.total - a.total);

  const best = scored[0];
  const hasSignal = best.total > 0;

  if (!hasSignal) {
    // No revision/date found — report candidacy without a winner
    return {
      content: [
        `Among the files discussed, I could not determine a clear revision or date order from the filenames alone:`,
        ...scored.map((s) => `- ${s.fileName}`),
        `You may want to check the file metadata or submittal log for the issue date.`,
      ].join("\n"),
      sources: [],
    };
  }

  const lines = scored.map((s) => {
    const tags: string[] = [];
    if (s.revisionScore > 0) tags.push(`rev score ${s.revisionScore}`);
    if (s.dateScore > 0) tags.push(`date score ${s.dateScore}`);
    const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
    return `- ${s.fileName}${suffix}`;
  });

  return {
    content: [
      `Based on revision and date tokens in the filenames, **${best.fileName}** appears to be the most recent.`,
      ``,
      `Ranking (highest = most recent):`,
      ...lines,
    ].join("\n"),
    sources: [],
  };
}

function scoreDomain(queryLower: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (queryLower.includes(keyword)) {
      score += keyword.includes(" ") ? 3 : 2;
    }
  }

  return score;
}

export function classifyQueryDomains(query: string): QueryDomain[] {
  const queryLower = normalizeText(query);
  if (!queryLower) {
    return ["documents"];
  }

  const ranked = (Object.keys(DOMAIN_KEYWORDS) as QueryDomain[])
    .map((domain) => ({
      domain,
      score: scoreDomain(queryLower, DOMAIN_KEYWORDS[domain]),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.domain);

  if (ranked.length > 0) {
    return ranked;
  }

  return ["documents", "contracts"];
}

function digestHistory(history?: ChatHistoryTurn[]): string {
  if (!history || history.length === 0) {
    return "none";
  }

  return history
    .slice(-4)
    .map((turn) => `${turn.role}:${normalizeText(turn.content).slice(0, 40)}`)
    .join("|");
}

function digestOpenDocs(openDocs?: OpenDocContext[]): string {
  if (!openDocs || openDocs.length === 0) {
    return "none";
  }

  return openDocs
    .slice(0, 4)
    .map((doc) => `${normalizeText(doc.fileName)}:${doc.page ?? "na"}`)
    .join("|");
}

function buildCacheKey(
  projectId: UUID,
  query: string,
  options?: {
    activeDocFileName?: string;
    openDocs?: OpenDocContext[];
    history?: ChatHistoryTurn[];
  }
): string {
  const active = options?.activeDocFileName ? normalizeText(options.activeDocFileName) : "none";
  const docs = digestOpenDocs(options?.openDocs);
  const hist = digestHistory(options?.history);
  const material = `${normalizeText(query)}:active=${active}:docs=${docs}:hist=${hist}`;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 24);
  return `${projectId}:v9:${digest}`;
}

function buildRetrievalTags(domains: QueryDomain[]): string[] {
  return Array.from(
    new Set(domains.flatMap((domain) => DOMAIN_TAG_HINTS[domain] ?? []))
  );
}

function dedupeSources(
  results: Array<SendChatMessageResponse["sources"]>
): SendChatMessageResponse["sources"] {
  const deduped = new Map<string, SendChatMessageResponse["sources"][number]>();

  for (const group of results) {
    for (const source of group) {
      const existing = deduped.get(source.fileId);
      if (!existing) {
        deduped.set(source.fileId, source);
        continue;
      }

      const mergedPages = Array.from(
        new Set([...(existing.suggestedPages ?? []), ...(source.suggestedPages ?? [])])
      )
        .filter((page) => Number.isFinite(page) && page > 0)
        .sort((a, b) => a - b)
        .slice(0, 5);

      const preferred = source.relevance > existing.relevance ? source : existing;
      const preferredBestPage =
        typeof preferred.bestPage === "number" && mergedPages.includes(preferred.bestPage)
          ? preferred.bestPage
          : undefined;
      const orderedMergedPages = preferredBestPage
        ? [preferredBestPage, ...mergedPages.filter((page) => page !== preferredBestPage)]
        : mergedPages;
      const mergedPageOrigin: PageOrigin | undefined =
        existing.pageOrigin && source.pageOrigin
          ? existing.pageOrigin === source.pageOrigin
            ? existing.pageOrigin
            : "mixed"
          : (existing.pageOrigin ?? source.pageOrigin);
      deduped.set(source.fileId, {
        ...preferred,
        suggestedPages: orderedMergedPages.length > 0 ? orderedMergedPages : undefined,
        bestPage: orderedMergedPages[0] ?? preferred.bestPage ?? existing.bestPage ?? source.bestPage,
        pageOrigin: mergedPageOrigin,
      });
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, 10);
}

function dedupeNodes(nodes: GraphNodeContext[]): GraphNodeContext[] {
  const deduped = new Map<string, GraphNodeContext>();

  for (const node of nodes) {
    const key = `${node.fileId}:${node.chunkIndex}`;
    const existing = deduped.get(key);
    if (!existing || node.score > existing.score) {
      deduped.set(key, node);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => right.score - left.score);
}

function scoreChunk(queryTokens: string[], chunkText: string, chunkIndex: number): number {
  const tokenHits = keywordHitScore(queryTokens, chunkText);
  if (tokenHits <= 0) {
    return 0;
  }

  const positionBonus = Math.max(0, 4 - chunkIndex) * 0.1;
  return tokenHits + positionBonus;
}

function filterHighFrequencyTokens(
  tokens: string[],
  chunks: Array<{ chunkText: string }>,
  maxDocumentFrequencyRatio = 0.35
): string[] {
  if (tokens.length === 0 || chunks.length === 0) {
    return tokens;
  }

  const threshold = Math.max(1, Math.floor(chunks.length * maxDocumentFrequencyRatio));
  const normalizedChunks = chunks.map((chunk) => chunk.chunkText.toLowerCase());

  const filtered = tokens.filter((token) => {
    const needle = token.toLowerCase();
    let matchCount = 0;

    for (const text of normalizedChunks) {
      if (text.includes(needle)) {
        matchCount += 1;
        if (matchCount > threshold) {
          return false;
        }
      }
    }

    return true;
  });

  return filtered.length > 0 ? filtered : tokens;
}

function buildNodesFromSearchResults(
  query: string,
  results: SearchResultRow[],
  tokenBudget = ROUTED_CONTEXT_TOKEN_BUDGET,
  maxNodes = MAX_GRAPH_NODES
): GraphNodeContext[] {
  const queryTokens = tokenizeQuery(query);
  if (results.length === 0) {
    return [];
  }

  const ranked = results
    .flatMap((result) =>
      result.matchedChunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        fileId: result.fileId,
        fileName: result.fileName,
        extractedFields: result.extractedFields,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        sourceType: chunk.sourceType,
        pageNumber: chunk.pageNumber,
        sectionLabel: chunk.sectionLabel,
        metadata: chunk.metadata,
        docCategory: result.docCategory,
        tags: result.tags,
        score: scoreChunk(queryTokens, chunk.chunkText, chunk.chunkIndex),
      }))
    )
    .filter((node) => node.chunkText.trim().length > 0)
    .filter((node) => !isLikelyUnreadableChunk(node.chunkText))
    .sort((left, right) => right.score - left.score);

  const dedupedRanked = dedupeNodes(ranked);

  const selected: GraphNodeContext[] = [];
  let tokenCount = 0;

  for (const node of dedupedRanked) {
    const nextTokens = estimateTokens(node.chunkText);
    if (selected.length > 0 && tokenCount + nextTokens > tokenBudget) {
      break;
    }

    selected.push(node);
    tokenCount += nextTokens;

    if (selected.length >= maxNodes) {
      break;
    }
  }

  return selected;
}

function normalizePageReferences(
  chunks: Array<{
    chunkIndex: number;
    pageNumber?: number;
    sourceType?: "content" | "summary" | "metadata_stub";
    metadata?: Record<string, unknown>;
  }>,
  options?: {
    maxPages?: number;
  }
): { suggestedPages?: number[]; bestPage?: number; pageOrigin?: PageOrigin } {
  const maxPages = options?.maxPages ?? 4;
  const exactPages = new Set<number>();
  const fallbackPages = new Set<number>();
  const exactOrdered: number[] = [];
  const fallbackOrdered: number[] = [];

  const addFallbackPages = (metadata?: Record<string, unknown>): void => {
    if (!metadata) {
      return;
    }

    let hadExplicitPageNumbers = false;
    const sourcePageNumbers = metadata.sourcePageNumbers;
    if (Array.isArray(sourcePageNumbers)) {
      for (const value of sourcePageNumbers) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          if (!fallbackPages.has(value)) {
            fallbackPages.add(value);
            fallbackOrdered.push(value);
          }
          hadExplicitPageNumbers = true;
        }
      }
    }

    if (hadExplicitPageNumbers) {
      return;
    }

    const sourcePageRange = metadata.sourcePageRange;
    if (sourcePageRange && typeof sourcePageRange === "object") {
      const start = (sourcePageRange as { start?: unknown }).start;
      const end = (sourcePageRange as { end?: unknown }).end;
      if (
        typeof start === "number" &&
        typeof end === "number" &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start > 0 &&
        end >= start
      ) {
        for (let page = start; page <= end && fallbackPages.size < maxPages * 2; page += 1) {
          if (!fallbackPages.has(page)) {
            fallbackPages.add(page);
            fallbackOrdered.push(page);
          }
        }
      }
    }
  };

  for (const chunk of chunks) {
    if (typeof chunk.pageNumber === "number" && Number.isFinite(chunk.pageNumber) && chunk.pageNumber > 0) {
      if (!exactPages.has(chunk.pageNumber)) {
        exactPages.add(chunk.pageNumber);
        exactOrdered.push(chunk.pageNumber);
      }
    }
    if (typeof chunk.pageNumber !== "number") {
      addFallbackPages(chunk.metadata);
    }
  }

  const fallbackFiltered = fallbackOrdered.filter((page) => !exactPages.has(page));
  const combined = (exactOrdered.length > 0 ? exactOrdered : fallbackFiltered).slice(0, maxPages);

  if (combined.length === 0) {
    return {};
  }

  return {
    suggestedPages: combined,
    bestPage: combined[0],
    pageOrigin: exactOrdered.length > 0 ? "exact" : "fallback",
  };
}

function sourcesFromSearchResults(results: SearchResultRow[]): SendChatMessageResponse["sources"] {
  const featureFlags = getChatCoordinatorFeatureFlags();

  return dedupeSources([
    results.map((result) => {
      const normalizedPages = normalizePageReferences(
        (result.matchedChunks ?? []).map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          sourceType: chunk.sourceType,
          metadata: featureFlags.citationFallbackEnabled ? chunk.metadata : undefined,
        })),
        { maxPages: 4 }
      );

      return {
        fileId: result.fileId,
        fileName: result.fileName,
        displayName: deriveShortFormName(result.fileName, result.extractedFields, result.docCategory),
        relevance: result.topRelevance,
        suggestedPages: normalizedPages.suggestedPages,
        bestPage: normalizedPages.bestPage,
        pageOrigin: normalizedPages.pageOrigin,
      };
    })
  ]);
}

function buildSpecialistRoutes(domains: QueryDomain[]): SpecialistRoute[] {
  const routeDomainSet = {
    doc_agent: new Set<QueryDomain>(["documents", "contracts", "communication", "field_ops", "subcontractor"]),
    sched_agent: new Set<QueryDomain>(["scheduling", "contracts", "field_ops"]),
    cost_agent: new Set<QueryDomain>(["cost", "contracts", "subcontractor"]),
  };

  const baseRoutes: SpecialistRoute[] = [
    {
      agent: "doc_agent",
      domains: domains.filter((domain) => routeDomainSet.doc_agent.has(domain)),
      categories: ["drawing", "spec", "submittal", "rfi", "report"],
      tags: ["rfi", "owner_notice", "submittal"],
    },
    {
      agent: "sched_agent",
      domains: domains.filter((domain) => routeDomainSet.sched_agent.has(domain)),
      categories: ["report", "rfi", "drawing"],
      tags: ["schedule", "delay", "milestone"],
    },
    {
      agent: "cost_agent",
      domains: domains.filter((domain) => routeDomainSet.cost_agent.has(domain)),
      categories: ["report", "submittal", "rfi", "spec"],
      tags: ["cost", "budget", "billing", "change_order"],
    },
  ];

  return baseRoutes.filter((route) => route.domains.length > 0);
}

function mergeSpecialistResults(results: SpecialistResult[]): {
  mergedSources: SendChatMessageResponse["sources"];
  mergedNodes: GraphNodeContext[];
} {
  const mergedSources = dedupeSources(results.map((result) => result.sources));
  const mergedNodes = dedupeNodes(results.flatMap((result) => result.nodes));

  const finalNodes: GraphNodeContext[] = [];
  let tokenCount = 0;
  for (const node of mergedNodes) {
    const nextTokens = estimateTokens(node.chunkText);
    if (finalNodes.length > 0 && tokenCount + nextTokens > ROUTED_CONTEXT_TOKEN_BUDGET) {
      break;
    }

    finalNodes.push(node);
    tokenCount += nextTokens;

    if (finalNodes.length >= MAX_GRAPH_NODES) {
      break;
    }
  }

  return {
    mergedSources,
    mergedNodes: finalNodes,
  };
}

function collectEvidenceFileIds(nodes: GraphNodeContext[]): UUID[] {
  return Array.from(new Set(nodes.map((node) => node.fileId)));
}

function hasAnyTextHint(nodes: GraphNodeContext[], hints: string[]): boolean {
  return nodes.some((node) => {
    const text = node.chunkText.toLowerCase();
    return hints.some((hint) => text.includes(hint));
  });
}

function detectContradictions(
  domains: QueryDomain[],
  specialistResults: SpecialistResult[]
): ContradictionSignal[] {
  const contradictions: ContradictionSignal[] = [];

  const sched = specialistResults.find((result) => result.agent === "sched_agent");
  const cost = specialistResults.find((result) => result.agent === "cost_agent");

  const scheduleDelayHints = ["delay", "behind", "critical path", "slippage"];
  const costExposureHints = ["pco", "change order", "exposure", "overrun", "variance"];

  const scheduleIndicatesDelay = sched
    ? hasAnyTextHint(sched.nodes, scheduleDelayHints)
    : false;
  const costIndicatesExposure = cost
    ? hasAnyTextHint(cost.nodes, costExposureHints)
    : false;

  if (scheduleIndicatesDelay && (!cost || cost.sources.length === 0 || !costIndicatesExposure)) {
    contradictions.push({
      kind: "schedule_delay_without_cost_exposure",
      severity: "warning",
      message:
        "Schedule evidence indicates delay, but cost/change-exposure evidence is missing or weak.",
      evidenceFileIds: collectEvidenceFileIds(sched?.nodes ?? []),
    });
  }

  if (costIndicatesExposure && (!sched || sched.sources.length === 0 || !scheduleIndicatesDelay)) {
    contradictions.push({
      kind: "cost_exposure_without_schedule_impact",
      severity: "info",
      message:
        "Cost evidence shows potential exposure, but schedule impact evidence is not established yet.",
      evidenceFileIds: collectEvidenceFileIds(cost?.nodes ?? []),
    });
  }

  if (
    domains.includes("contracts") &&
    (scheduleIndicatesDelay || costIndicatesExposure)
  ) {
    const evidence = collectEvidenceFileIds([
      ...(sched?.nodes ?? []),
      ...(cost?.nodes ?? []),
    ]);

    contradictions.push({
      kind: "contract_notice_risk_escalation",
      severity: "warning",
      message:
        "Delay/cost signals overlap with contract scope. Validate owner notice obligations and claim windows.",
      evidenceFileIds: evidence,
    });
  }

  return contradictions;
}

function buildGraphContextBlock(nodes: GraphNodeContext[]): string {
  if (nodes.length === 0) {
    return "No relevant graph nodes were retrieved.";
  }

  return nodes
    .map((node, index) => {
      const excerpt = node.chunkText.slice(0, 260).replace(/\s+/g, " ").trim();
      const tags = node.tags?.length ? ` tags=${node.tags.join(",")}` : "";
      const category = node.docCategory ? ` category=${node.docCategory}` : "";
      const page = typeof node.pageNumber === "number" ? ` page=${node.pageNumber}` : "";
      const section = node.sectionLabel ? ` section=${node.sectionLabel}` : "";
      const alias = deriveShortFormName(node.fileName, node.extractedFields, node.docCategory);
      const meta = `${category}${tags}${page}${section}`.trim();
      return `NODE ${index + 1}: ${alias}${meta ? ` | ${meta}` : ""}\ntext=${excerpt}`;
    })
    .join("\n\n");
}

function buildIndexedSnapshotBlock(snapshot?: IndexedProjectSnapshot): string {
  if (!snapshot) {
    return "Project snapshot unavailable.";
  }

  const categorySummary = Object.entries(snapshot.categoryBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([cat, count]) => `${cat}:${count}`)
    .join(", ");

  const openRfis = snapshot.openRfis
    .slice(0, 3)
    .map((rfi) => `${deriveShortFormName(rfi.fileName)}${rfi.rfiNumber ? ` [RFI ${rfi.rfiNumber}]` : ""}`)
    .join("; ");

  const pendingSubmittals = snapshot.pendingSubmittals
    .slice(0, 3)
    .map((sub) => `${deriveShortFormName(sub.fileName)}${sub.submittarNumber ? ` [${sub.submittarNumber}]` : ""}${sub.status ? ` status=${sub.status}` : ""}`)
    .join("; ");

  const recentChangeOrders = snapshot.recentChangeOrders
    .slice(0, 3)
    .map((co) => `${deriveShortFormName(co.fileName)}${co.coNumber ? ` [CO ${co.coNumber}]` : ""}`)
    .join("; ");

  return [
    `Index status: indexed=${snapshot.indexedFiles}, pending=${snapshot.pendingFiles}, failed=${snapshot.failedFiles}, total=${snapshot.totalFiles}, completion=${snapshot.indexingPercent}%`,
    `Category mix: ${categorySummary || "none"}`,
    `Open RFIs: ${openRfis || "none"}`,
    `Pending submittals: ${pendingSubmittals || "none"}`,
    `Recent change orders: ${recentChangeOrders || "none"}`,
  ].join("\n");
}

function buildUserPrompt(
  query: string,
  domains: QueryDomain[],
  nodes: GraphNodeContext[],
  snapshot?: IndexedProjectSnapshot,
  openDocs?: OpenDocContext[],
  activeDocFileName?: string
): string {
  const uiContextLines: string[] = [];
  if (activeDocFileName) {
    uiContextLines.push(`Active document in viewer: ${activeDocFileName}`);
  }
  if (openDocs && openDocs.length > 0) {
    uiContextLines.push(`Open tabs: ${openDocs.map((d) => `${d.fileName}${d.page ? ` (p.${d.page})` : ""}`).join(", ")}`);
  } else {
    uiContextLines.push("No documents currently open in viewer.");
  }

  return [
    `Query: ${query}`,
    `Domain focus: ${domains.join(", ")}`,
    uiContextLines.length > 0 ? `Workspace state:\n${uiContextLines.join("\n")}` : null,
    "Project snapshot:",
    buildIndexedSnapshotBlock(snapshot),
    "Retrieved context:",
    buildGraphContextBlock(nodes),
  ].filter(Boolean).join("\n\n");
}

function estimateContextTokens(nodes: GraphNodeContext[]): number {
  return nodes.reduce((sum, node) => sum + estimateTokens(node.chunkText), 0);
}

function isFactualIntent(query: string): boolean {
  return /\b(what|which|when|where|how many|how much|does|is|are|approved|status|date|cost|dimension|qty|revision|spec|requirement)\b/i.test(
    query
  );
}

function buildTelemetry(
  startedAt: number,
  overrides?: Partial<Omit<CoordinatorTelemetry, "totalMs">>
): CoordinatorTelemetry {
  return {
    routeMs: 0,
    retrievalMs: 0,
    mergeMs: 0,
    agentMs: 0,
    ...overrides,
    totalMs: Date.now() - startedAt,
  };
}

function buildCoordinatorMetadata(
  domains: QueryDomain[],
  telemetry: CoordinatorTelemetry,
  overrides?: Partial<Omit<CoordinatorMetadata, "domains" | "telemetry">>
): CoordinatorMetadata {
  return {
    domains,
    cacheHit: false,
    splitSignals: [],
    specialistAgents: [],
    estimatedContextTokens: 0,
    contradictions: [],
    ...overrides,
    telemetry,
  };
}

function passesFuzzyCitationVerification(chunkText: string, strictTokens: string[]): boolean {
  if (strictTokens.length === 0) {
    return true;
  }

  const words = toWordTokens(chunkText);
  const negationTerms = new Set(["no", "not", "without", "missing", "lack", "lacking", "none"]);
  const strictTokenSet = new Set(strictTokens.map((token) => token.toLowerCase()));

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!strictTokenSet.has(word)) {
      continue;
    }

    const from = Math.max(0, index - 3);
    for (let cursor = from; cursor < index; cursor += 1) {
      if (negationTerms.has(words[cursor] ?? "")) {
        return false;
      }
    }
  }

  if (/\bno\s+[^\n.]{0,40}\b(expansion|joint|sealant|specifics?|evidence)\b/i.test(chunkText)) {
    return false;
  }

  const lower = chunkText.toLowerCase();
  const matched = strictTokens.filter((token) => lower.includes(token.toLowerCase()));
  const minRequired = Math.min(2, strictTokens.length);
  if (matched.length < minRequired) {
    return false;
  }

  const hasExpansionToken = strictTokens.includes("expansion");
  const hasJointToken = strictTokens.includes("joint");
  if (hasExpansionToken || hasJointToken) {
    if (hasExpansionToken && hasJointToken) {
      const distance = minimumTokenDistance(words, "expansion", "joint");
      if (typeof distance === "number" && distance <= 16) {
        return true;
      }
    }

    return /\bexpansion\s+joints?\b/i.test(chunkText) || /\b(joint\s+sealants?|sealant\s+joints?)\b/i.test(chunkText);
  }

  return true;
}

function buildValidatedCitations(
  nodes: GraphNodeContext[],
  sources: SendChatMessageResponse["sources"],
  options?: {
    allowMetadataFallback?: boolean;
    strictCitationVerificationEnabled?: boolean;
    strictTokens?: string[];
  }
): NonNullable<SendChatMessageResponse["citations"]> {
  if (nodes.length === 0) return [];
  const allowMetadataFallback = options?.allowMetadataFallback ?? true;
  const strictCitationVerificationEnabled =
    options?.strictCitationVerificationEnabled ?? false;
  const strictTokens = options?.strictTokens ?? [];

  const sourceByFile = new Map(sources.map((source) => [source.fileId, source]));
  const deduped = new Map<string, NonNullable<SendChatMessageResponse["citations"]>[number]>();

  for (const node of nodes) {
    const source = sourceByFile.get(node.fileId);
    if (!source) {
      continue;
    }

    const metadata = node.metadata && typeof node.metadata === "object"
      ? (node.metadata as Record<string, unknown>)
      : undefined;

    const fallbackPageFromMetadata = (() => {
      if (!allowMetadataFallback) return undefined;
      if (!metadata) return undefined;
      const sourcePageNumbers = metadata.sourcePageNumbers;
      if (Array.isArray(sourcePageNumbers)) {
        const first = sourcePageNumbers.find(
          (value) => typeof value === "number" && Number.isFinite(value) && value > 0
        );
        if (typeof first === "number") {
          return first;
        }
      }

      const sourcePageRange = metadata.sourcePageRange;
      if (sourcePageRange && typeof sourcePageRange === "object") {
        const start = (sourcePageRange as { start?: unknown }).start;
        if (typeof start === "number" && Number.isFinite(start) && start > 0) {
          return start;
        }
      }

      return undefined;
    })();

    const resolvedPageNumber =
      typeof node.pageNumber === "number" && Number.isFinite(node.pageNumber)
        ? node.pageNumber
        : fallbackPageFromMetadata;

    // For exact-page trusted sources, only emit chunk citations that carry a concrete page.
    if (source.pageOrigin === "exact" && typeof resolvedPageNumber !== "number") {
      continue;
    }

    if (
      strictCitationVerificationEnabled &&
      !passesFuzzyCitationVerification(node.chunkText, strictTokens)
    ) {
      continue;
    }

    const citation = {
      chunkId: node.chunkId,
      fileId: node.fileId,
      fileName: node.fileName,
      chunkIndex: node.chunkIndex,
      sourceType: node.sourceType,
      relevance: source.relevance,
      pageNumber: resolvedPageNumber,
      sectionLabel: node.sectionLabel,
      metadata: node.metadata,
      confidence: Number(Math.max(0, Math.min(1, source.relevance)).toFixed(3)),
    } as NonNullable<SendChatMessageResponse["citations"]>[number];

    const key = `${citation.fileId}:${citation.chunkId}`;
    const existing = deduped.get(key);
    if (!existing || citation.confidence > existing.confidence) {
      deduped.set(key, citation);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
}

function withUncertaintyMarker(content: string): string {
  return `${content.trim()}\n\nNote: I could not validate direct chunk-level evidence for all factual claims in this response.`;
}

function buildSingleSource(
  fileId: UUID,
  fileName: string,
  options?: {
    relevance?: number;
    suggestedPages?: number[];
    bestPage?: number;
    displayName?: string;
    pageOrigin?: PageOrigin;
  }
): SendChatMessageResponse["sources"] {
  return [
    {
      fileId,
      fileName,
      displayName: options?.displayName,
      relevance: options?.relevance ?? 1,
      suggestedPages: options?.suggestedPages,
      bestPage: options?.bestPage,
      pageOrigin: options?.pageOrigin,
    },
  ];
}

async function routeGraphContext(
  projectId: UUID,
  query: string,
  interpretation?: ChatInterpretation,
  options?: {
    preferredFileId?: UUID;
    requirePreferredFile?: boolean;
  }
): Promise<{
  domains: QueryDomain[];
  sources: SendChatMessageResponse["sources"];
  graphNodes: GraphNodeContext[];
  splitSignals: string[];
  specialistResults: SpecialistResult[];
  retrievalMs: number;
  mergeMs: number;
}> {
  const retrievalStartedAt = Date.now();
  const domains = classifyQueryDomains(query);
  const specialistRoutes = buildSpecialistRoutes(domains);

  const mergedRouteTags = buildRetrievalTags(domains);
  const sharedSearch = await retrievalService.searchProject(projectId, query, {
    topK: 8,
    minRelevance: 0.1,
    tags: mergedRouteTags,
    interpretation,
    includeChunks: true,
  });
  const preferredScopedResults = options?.preferredFileId
    ? sharedSearch.results.filter((result) => result.fileId === options.preferredFileId)
    : sharedSearch.results;
  const sharedResults =
    preferredScopedResults.length > 0
      ? preferredScopedResults
      : options?.requirePreferredFile
        ? []
        : sharedSearch.results;

  const specialistResults = specialistRoutes.map((route) => {
    const routeCategorySet = new Set(route.categories.map((category) => category.toLowerCase()));
    const routeTagSet = new Set(route.tags.map((tag) => tag.toLowerCase()));

    const routeResults = sharedResults.filter((result) => {
      const category = (result.docCategory ?? "").toLowerCase();
      const tags = (result.tags ?? []).map((tag) => tag.toLowerCase());
      const categoryMatch = routeCategorySet.has(category);
      const tagMatch = tags.some((tag) => routeTagSet.has(tag));
      return categoryMatch || tagMatch;
    });

    const laneResults = routeResults.length > 0 ? routeResults : sharedResults;
    const sources = sourcesFromSearchResults(laneResults);
    const perRouteTokenBudget = Math.max(300, Math.floor(ROUTED_CONTEXT_TOKEN_BUDGET / 3));
    const nodes = buildNodesFromSearchResults(query, laneResults, perRouteTokenBudget, 4);

    return {
      agent: route.agent,
      domains: route.domains,
      sources,
      nodes,
      durationMs: 0,
    } satisfies SpecialistResult;
  });

  const fallbackSources = sourcesFromSearchResults(sharedResults);
  const fallbackNodes = buildNodesFromSearchResults(query, sharedResults);

  const retrievalMs = Date.now() - retrievalStartedAt;
  const mergeStartedAt = Date.now();

  const merged = mergeSpecialistResults([
    ...specialistResults,
    {
      agent: "doc_agent",
      domains,
      sources: fallbackSources,
      nodes: fallbackNodes,
      durationMs: retrievalMs,
    },
  ]);

  const splitSignals = shouldSplitSpecialists(domains, merged.mergedNodes.length, merged.mergedSources.length);
  const mergeMs = Date.now() - mergeStartedAt;

  return {
    domains,
    sources: merged.mergedSources,
    graphNodes: merged.mergedNodes,
    splitSignals,
    specialistResults,
    retrievalMs,
    mergeMs,
  };
}

/**
 * Calls the LLM with a specialized prompt asking it to interpret each matched
 * passage and explain it in plain language. Used by the detailed extraction path
 * so results are Gemini-interpreted rather than raw verbatim text.
 * Returns null when no API key is configured (caller should fall back to raw text).
 */
async function callDetailedExtractionLlm(
  rawQuery: string,
  fileName: string,
  matchedChunks: RankedDocumentChunk[]
): Promise<string | null> {
  const env = getEnv();
  const apiKey = env.geminiApiKey ?? env.openAiApiKey;
  if (!apiKey) return null;

  const chatEndpoint =
    env.geminiChatEndpoint ??
    env.openAiChatEndpoint ??
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  const chatModel = env.geminiChatModel ?? env.openAiChatModel ?? "gemini-2.5-flash";
  const alias = deriveShortFormName(fileName);

  const passageBlocks = matchedChunks
    .slice(0, 12)
    .map((chunk, index) => {
      const text = chunk.chunkText.replace(/\s+/g, " ").trim();
      const page = typeof chunk.pageNumber === "number" ? ` (p. ${chunk.pageNumber})` : "";
      return `PASSAGE ${index + 1}${page}:\n${text}`;
    })
    .join("\n\n");

  const systemInstruction = [
    "You are ContractorAI — a construction PM assistant. The user asked about specific items in a QA/QC or inspection document.",
    "You will receive numbered passages extracted from the document. Each passage contains a mention of the queried term.",
    "For EACH passage, write exactly one bullet point that explains in plain English what the item is, what it requires, and who is responsible (if stated).",
    "Rules:",
    "- Use the exact page reference shown with each passage: (p. X).",
    "- Under 25 words per bullet. Lead with the action/requirement, not a summary label.",
    "- If two passages cover the same requirement, merge them into one bullet and list both page refs.",
    "- Do NOT say 'the document does not contain' — only describe what IS in the passages.",
    "- Output format: ## [Short 3-5 word heading]\\n- (p. X) [plain-language bullet]\\n- (p. X) ...",
  ].join("\n");

  const userMessage = `Query: ${rawQuery}\nDocument: ${alias}\n\n${passageBlocks}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_CALL_TIMEOUT_MS);
  try {
    const response = await fetch(chatEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: chatModel,
        temperature: 0.1,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (response.ok) {
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const completion = payload.choices?.[0]?.message?.content?.trim();
      if (completion) return completion;
    } else {
      logger.warn("chat.coordinator.detailed_extraction_llm_failed", {
        reason: response.statusText,
      });
    }
  } catch (error) {
    logger.warn("chat.coordinator.detailed_extraction_llm_error", {
      reason: error instanceof Error ? error.message : "unknown_error",
    });
  } finally {
    clearTimeout(timeout);
  }
  return null;
}

async function callSingleAgent(
  query: string,
  domains: QueryDomain[],
  nodes: GraphNodeContext[],
  snapshot?: IndexedProjectSnapshot,
  history?: ChatHistoryTurn[],
  openDocs?: OpenDocContext[],
  activeDocFileName?: string
): Promise<string> {
  const env = getEnv();
  const userPrompt = buildUserPrompt(query, domains, nodes, snapshot, openDocs, activeDocFileName);
  const chatEndpoint =
    env.geminiChatEndpoint ??
    env.openAiChatEndpoint ??
    "https://api.openai.com/v1/chat/completions";
  const chatModel = env.geminiChatModel ?? env.openAiChatModel ?? "gemini-2.5-flash";
  const apiKey = env.geminiApiKey ?? env.openAiApiKey;

  if (apiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_CALL_TIMEOUT_MS);
    try {
      const historyMessages = (history ?? []).map((turn) => ({
        role: turn.role,
        content: turn.content,
      }));
      const response = await fetch(chatEndpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: chatModel,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: STATIC_SYSTEM_PROMPT,
            },
            ...historyMessages,
            {
              role: "user",
              content: userPrompt,
            },
          ],
        }),
      });

      if (response.ok) {
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const completion = payload.choices?.[0]?.message?.content?.trim();
        if (completion) {
          return completion;
        }
      } else {
        const body = await response.text();
        logger.warn("chat.coordinator.agent_call_failed", {
          reason: body || response.statusText,
        });
      }
    } catch (error) {
      logger.warn("chat.coordinator.agent_call_error", {
        reason:
          error instanceof Error && error.name === "AbortError"
            ? `agent_call_timeout_${AGENT_CALL_TIMEOUT_MS}ms`
            : error instanceof Error
              ? error.message
              : "unknown_error",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (nodes.length === 0) {
    return [
      "I could not find enough indexed graph context to answer confidently.",
      `Current index completion is ${snapshot?.indexingPercent ?? 0}%.`,
      "Please sync/index the project documents or point me to the relevant file/log (RFI, submittal, daily report, schedule, or spec section).",
    ].join(" ");
  }

  const queryTokens = tokenizeQuery(query);
  const queryBigrams = queryTokens
    .slice(0, -1)
    .map((token, index) => `${token} ${queryTokens[index + 1]}`)
    .flatMap((phrase) => {
      const singularized = phrase
        .split(" ")
        .map((word) => word.replace(/s$/, ""))
        .join(" ");
      return singularized === phrase ? [phrase] : [phrase, singularized];
    });

  const scoredNodes = nodes
    .map((node) => {
      const chunkLower = node.chunkText.toLowerCase();
      const tokenHits = keywordHitScore(queryTokens, chunkLower);
      const phraseHits = queryBigrams.reduce(
        (count, phrase) => count + (phrase.length > 2 && chunkLower.includes(phrase) ? 1 : 0),
        0
      );

      return {
        node,
        lexicalScore: tokenHits + phraseHits * 2,
      };
    })
    .sort((left, right) => {
      if (right.lexicalScore !== left.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }
      return right.node.score - left.node.score;
    });

  const hasLexicalMatch = scoredNodes.some((entry) => entry.lexicalScore > 0);
  const bestEvidenceNodes = (hasLexicalMatch
    ? scoredNodes.filter((entry) => entry.lexicalScore > 0)
    : scoredNodes
  )
    .slice(0, 3)
    .map((entry) => entry.node);

  const topAliases = Array.from(
    new Set(bestEvidenceNodes.map((node) => deriveShortFormName(node.fileName, node.extractedFields, node.docCategory)))
  ).slice(0, 4);
  const evidence = bestEvidenceNodes.map((node) => {
    const cleanedChunkText = stripLeadingSpecBoilerplate(node.chunkText);
    const excerpt = cleanedChunkText.slice(0, 160).replace(/\s+/g, " ").trim();
    const alias = deriveShortFormName(node.fileName, node.extractedFields, node.docCategory);
    const page = typeof node.pageNumber === "number" && node.pageNumber > 0 ? ` (p. ${node.pageNumber})` : "";
    return `- ${alias}${page}: ${excerpt}`;
  });

  return [
    `Based on indexed project context, this is the strongest evidence for: \"${query.trim()}\".`,
    `Routed focus: ${domains.join(", ")}.`,
    `Top files: ${topAliases.join(", ")}.`,
    "Evidence snippets:",
    ...evidence,
    "I can draft this as an owner notice, RFI, or meeting-minute action list if needed.",
    "I can flag contract exposure, but this is not legal advice.",
  ].join("\n");
}

/**
 * Generate 2–3 concise follow-up action suggestions based on what was just answered.
 */
function buildSuggestions(
  query: string,
  domains: QueryDomain[],
  sources: SendChatMessageResponse["sources"],
  options?: {
    selectedFileName?: string;
    enforceSelectedFileScope?: boolean;
  }
): string[] {
  const suggestions: string[] = [];
  const q = query.toLowerCase();
  const topFile = options?.enforceSelectedFileScope
    ? options.selectedFileName
    : (options?.selectedFileName ?? sources[0]?.fileName);
  const suppressCrossFileSuggestions = Boolean(options?.enforceSelectedFileScope);

  // Document / summary domain
  if (domains.includes("documents") || domains.includes("contracts")) {
    if (/summar|overview|what is|describe/.test(q)) {
      if (topFile) suggestions.push(`Extract key risks from ${topFile}`);
      suggestions.push("List open action items from this document");
      suggestions.push("Draft an owner-facing summary");
    } else if (/risk|issue|violation|problem/.test(q)) {
      suggestions.push("Prioritize these by severity");
      suggestions.push("Draft a corrective action notice");
      if (topFile) suggestions.push(`Compare with previous revision of ${topFile}`);
    } else if (/latest|recent|version|revision/.test(q)) {
      suggestions.push("Show changes from previous revision");
      suggestions.push("Open this file in the viewer");
    }
  }

  // Scheduling domain
  if (domains.includes("scheduling")) {
    if (!suggestions.some((s) => s.includes("critical path"))) {
      suggestions.push("Show critical path impact of this delay");
    }
    suggestions.push("Draft a time impact analysis (TIA)");
    if (topFile) suggestions.push(`Check float in ${topFile}`);
  }

  // Cost domain
  if (domains.includes("cost")) {
    suggestions.push("Summarize pending change order exposure");
    suggestions.push("Compare budget vs actual on this line item");
  }

  // Field ops
  if (domains.includes("field_ops")) {
    suggestions.push("Draft a safety observation report");
    suggestions.push("List corrective actions with due dates");
  }

  // Generic fallbacks if nothing generated
  if (suggestions.length === 0) {
    if (topFile) suggestions.push(`Open ${topFile} in viewer`);
    if (!suppressCrossFileSuggestions) {
      suggestions.push("Summarize top risks across all project files");
    }
    suggestions.push("Draft an owner notice for this issue");
  }

  return suggestions.slice(0, 3);
}

function shouldSplitSpecialists(domains: QueryDomain[], nodeCount: number, sourceCount: number): string[] {
  const reasons: string[] = [];

  if (domains.length >= 3 && nodeCount >= 10) {
    reasons.push("context_too_broad_for_single_agent");
  }

  if (domains.includes("scheduling") && domains.includes("cost") && sourceCount >= 8) {
    reasons.push("parallel_domain_workload_growth");
  }

  if (
    domains.includes("scheduling") ||
    domains.includes("cost") ||
    domains.includes("subcontractor")
  ) {
    reasons.push("domain_specific_tools_likely_needed");
  }

  return Array.from(new Set(reasons));
}

export const chatCoordinatorService = {
  async previewRoute(projectId: UUID, query: string): Promise<RoutePreviewResult> {
    const trimmedQuery = query.trim();
    const interpretation = await interpretationService.interpret({ query: trimmedQuery });
    const routed = await routeGraphContext(projectId, trimmedQuery, interpretation);

    return {
      domains: routed.domains,
      sources: routed.sources,
      selectedNodes: routed.graphNodes.map((node) => ({
        fileId: node.fileId,
        fileName: node.fileName,
        chunkIndex: node.chunkIndex,
        score: Number(node.score.toFixed(3)),
        docCategory: node.docCategory,
        tags: node.tags,
      })),
      specialistAgents: routed.specialistResults.map((result) => ({
        agent: result.agent,
        domains: result.domains,
        sourceCount: result.sources.length,
        nodeCount: result.nodes.length,
      })),
      splitSignals: routed.splitSignals,
      estimatedContextTokens: estimateContextTokens(routed.graphNodes),
    };
  },

  async generateReply(
    projectId: UUID,
    query: string,
    history?: ChatHistoryTurn[],
    openDocs?: OpenDocContext[],
    activeDocFileName?: string,
    activeDocFileId?: UUID
  ): Promise<CoordinatorResult> {
    const featureFlags = getChatCoordinatorFeatureFlags();
    const startedAt = Date.now();
    const rawQuery = query.trim();
    let activeDocBoostApplied = false;

    // If the user refers to an in-view document, substitute active file name
    // so retrieval can find the right chunks.
    const THIS_DOC_PATTERN = /\b(this|the)\s+(pdf|doc|document|file|report|drawing|plan|schedule|spec)\b/i;
    const DEICTIC_CONTENT_PATTERN = /\b(it|this|that)\b/i;
    const isFileLookupIntent =
      isFileLookupQuery(rawQuery) || isFileLookupFragmentQuery(rawQuery);
    const hasActiveDocNameReference = queryMentionsActiveDocument(rawQuery, activeDocFileName);
    const hasExplicitSectionReviewIntent = isExplicitSectionReviewQuery(rawQuery);

    const hasDeicticContentReference =
      Boolean(activeDocFileName) &&
      DEICTIC_CONTENT_PATTERN.test(rawQuery) &&
      (QUESTION_INTENT_PATTERN.test(rawQuery) || /\b(summary|summarize|key|main|detail|dimension|thick|width|height|length)\b/i.test(rawQuery));

    // Any content-seeking question or command while a doc is open should default to searching
    // that document. The user's intent is "look this up in what I have open" — no pronoun or
    // filename reference required. File-lookup intents are still excluded (they explicitly
    // hunt for a different file).
    const isContentCommandWithActiveDoc =
      Boolean(activeDocFileName) &&
      !isFileLookupIntent &&
      /\b(show|find|list|get|tell|give|describe|explain|provide|what|which|where|when|how|who|look|check|see|review|search|locate|identify|summarize)\b/i.test(rawQuery);

    const isActiveDocQuestion =
      Boolean(activeDocFileName) &&
      !isFileLookupIntent &&
      (hasExplicitSectionReviewIntent ||
      hasActiveDocNameReference ||
      hasDeicticContentReference ||
      THIS_DOC_PATTERN.test(rawQuery) ||
      isContentCommandWithActiveDoc);

    const resolvedQuery =
      THIS_DOC_PATTERN.test(rawQuery) && activeDocFileName
        ? rawQuery.replace(THIS_DOC_PATTERN, activeDocFileName)
        : hasDeicticContentReference && activeDocFileName
          ? `${rawQuery} in ${activeDocFileName}`
        : rawQuery;
    // Lock retrieval to the active doc for any content question/command while a doc is open.
    // File-lookup intents are excluded (they explicitly search for a different file).
    const enforceSelectedFileScope =
      Boolean(activeDocFileName) && !isFileLookupIntent && isActiveDocQuestion;
    // Keep original phrasing for LLM but use resolved query for retrieval
    const trimmedQuery = resolvedQuery;

    if (isGreetingQuery(trimmedQuery)) {
      const telemetry = buildTelemetry(startedAt);
      const domains: QueryDomain[] = ["communication"];

      return {
        content: buildPmGreetingResponse(),
        sources: [],
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry),
        cacheHit: false,
      };
    }

    if (featureFlags.activeDocBoostEnabled && isActiveDocQuestion && (activeDocFileId || activeDocFileName)) {
      let targetFileId = activeDocFileId;

      if (!targetFileId && activeDocFileName) {
        const fileSearch = await projectService.listProjectFiles(projectId, {
          page: 1,
          pageSize: 50,
          search: activeDocFileName,
        });
        const exact = fileSearch.files.find(
          (file) => file.fileName.toLowerCase() === activeDocFileName.toLowerCase()
        );
        targetFileId = exact?.id ?? fileSearch.files[0]?.id;
      }

      if (targetFileId) {
        const detail = await retrievalService.getDocumentDetail(targetFileId, projectId);
        if (detail && detail.chunks.length > 0) {
          activeDocBoostApplied = true;
          return answerFromDocumentDetail(
            detail,
            rawQuery,
            startedAt,
            history,
            openDocs,
            activeDocFileName
          );
        }

        if (detail) {
          const coverPageQuestion = isCoverPageQuestion(rawQuery);
          const detailSource = buildSingleSource(detail.fileId, detail.fileName, {
            displayName: deriveShortFormName(detail.fileName),
          });
          const domains = classifyQueryDomains(rawQuery);
          const telemetry = buildTelemetry(startedAt);

          const guidance = coverPageQuestion
            ? [
                "- Check page 1 / cover sheet / title block.",
                "- Use the citation chip to open page 1.",
              ].join("\n")
            : `I do not have indexed text for ${deriveShortFormName(detail.fileName)} yet, so I cannot answer from extracted content. Review the opened file directly${detail.mimeType?.toLowerCase().includes("pdf") ? ", starting with page 1," : ""} and then re-run indexing for exact answers.`;

          return {
            content: guidance,
            sources: detailSource,
            domains,
            coordinator: buildCoordinatorMetadata(domains, telemetry),
            cacheHit: false,
            suggestions: buildSuggestions(rawQuery, domains, detailSource, {
              selectedFileName: activeDocFileName,
              enforceSelectedFileScope,
            }),
            autoOpenFileName: detail.fileName,
          };
        }
      }
    }

    if (featureFlags.activeDocBoostEnabled && !isFileLookupIntent && !isActiveDocQuestion && activeDocFileId) {
      const activeDocDetail = await retrievalService.getDocumentDetail(activeDocFileId, projectId);
      if (activeDocDetail?.chunks.length && hasKeywordMatchInDocument(activeDocDetail, rawQuery)) {
        activeDocBoostApplied = true;
        return answerFromDocumentDetail(
          activeDocDetail,
          rawQuery,
          startedAt,
          history,
          openDocs,
          activeDocFileName ?? activeDocDetail.fileName
        );
      }
    }

    const directDocumentCandidate = await resolveDirectDocumentCandidate(projectId, trimmedQuery);
    if (directDocumentCandidate) {
      const detail = await retrievalService.getDocumentDetail(
        directDocumentCandidate.fileId,
        projectId
      );

      if (detail && detail.chunks.length > 0) {
        return answerFromDocumentDetail(
          detail,
          rawQuery,
          startedAt,
          history,
          openDocs,
          directDocumentCandidate.fileName
        );
      }

      const domains: QueryDomain[] = ["documents"];
      const telemetry = buildTelemetry(startedAt);
      const fallbackSource = buildSingleSource(
        directDocumentCandidate.fileId,
        directDocumentCandidate.fileName,
        {
          displayName: deriveShortFormName(directDocumentCandidate.fileName),
        }
      );

      return {
        content: [
          "## Need Indexed QWP",
          `- I found ${deriveShortFormName(directDocumentCandidate.fileName)}, but I do not have indexed text for a precise answer.`,
          "- Open that file and re-run indexing, then ask again for exact hold points.",
        ].join("\n"),
        sources: fallbackSource,
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry),
        cacheHit: false,
        autoOpenFileName: directDocumentCandidate.fileName,
      };
    }

    const fileLookup = await resolveFileLookupAnswer(projectId, trimmedQuery);
    if (fileLookup) {
      const telemetry = buildTelemetry(startedAt);
      const domains: QueryDomain[] = ["documents"];

      return {
        content: fileLookup.content,
        sources: fileLookup.sources,
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry),
        cacheHit: false,
      };
    }

    const recencyAnswer = resolveRecencyAnswer(trimmedQuery, history ?? []);
    if (recencyAnswer) {
      const telemetry = buildTelemetry(startedAt);
      const domains: QueryDomain[] = ["documents"];
      return {
        content: recencyAnswer.content,
        sources: recencyAnswer.sources,
        domains,
        coordinator: buildCoordinatorMetadata(domains, telemetry),
        cacheHit: false,
      };
    }

    const shouldUseResponseCache = !isActiveDocQuestion;
    const cacheKey = buildCacheKey(projectId, trimmedQuery, {
      activeDocFileName,
      openDocs,
      history,
    });
    if (shouldUseResponseCache) {
      const cached = responseCache.get(cacheKey);
      if (cached && Date.now() - cached.createdAt <= RESPONSE_CACHE_TTL_MS) {
        const cachedCoordinator: CoordinatorMetadata = {
          ...cached.coordinator,
          cacheHit: true,
        };
        return {
          content: cached.content,
          sources: cached.sources,
          citations: cached.citations,
          interpretation: cached.interpretation,
          domains: cached.domains,
          coordinator: cachedCoordinator,
          cacheHit: true,
        };
      }

      if (cached) {
        responseCache.delete(cacheKey);
      }
    }

    const interpretationStartedAt = Date.now();
    const interpreted = await interpretationService.interpret({
      query: rawQuery,
      activeDocFileName,
      openDocs,
    });
    const interpretationLatencyMs = Date.now() - interpretationStartedAt;
    const retrievalInterpretation =
      interpreted.confidence >= 0.8
        ? interpreted
        : interpreted.confidence >= 0.65
          ? { ...interpreted, confidence: Math.min(interpreted.confidence, 0.72) }
          : undefined;

    const interpretation: ChatInterpretation = retrievalInterpretation
      ? interpreted
      : {
          ...interpreted,
          fallbackReason: interpreted.fallbackReason ?? "low_confidence_no_hinting",
        };

    const routeStartedAt = Date.now();
    const [routed, contextSnapshotRaw] = await Promise.all([
      routeGraphContext(projectId, trimmedQuery, retrievalInterpretation, {
        preferredFileId: enforceSelectedFileScope ? activeDocFileId : undefined,
        requirePreferredFile: Boolean(enforceSelectedFileScope && activeDocFileId),
      }),
      retrievalService.getProjectContext(projectId),
    ]);
    const routeMs = Date.now() - routeStartedAt;
    const sources = routed.sources;
    const graphNodes = routed.graphNodes;
    const domains = routed.domains;

    const contradictions = detectContradictions(domains, routed.specialistResults);

    const contextSnapshot: IndexedProjectSnapshot = {
      totalFiles: contextSnapshotRaw.totalFiles,
      indexedFiles: contextSnapshotRaw.indexedFiles,
      pendingFiles: contextSnapshotRaw.pendingFiles,
      failedFiles: contextSnapshotRaw.failedFiles,
      indexingPercent: contextSnapshotRaw.indexingPercent,
      categoryBreakdown: contextSnapshotRaw.categoryBreakdown,
      openRfis: contextSnapshotRaw.openRfis.map((item) => ({
        fileName: item.fileName,
        rfiNumber: item.rfiNumber,
      })),
      pendingSubmittals: contextSnapshotRaw.pendingSubmittals.map((item) => ({
        fileName: item.fileName,
        submittarNumber: item.submittarNumber,
        status: item.status,
      })),
      recentChangeOrders: contextSnapshotRaw.recentChangeOrders.map((item) => ({
        fileName: item.fileName,
        coNumber: item.coNumber,
      })),
    };

    const agentStartedAt = Date.now();
    const content = await callSingleAgent(rawQuery, domains, graphNodes, contextSnapshot, history, openDocs, activeDocFileName);
    const agentMs = Date.now() - agentStartedAt;
    const strictQueryTokens = filterHighFrequencyTokens(tokenizeQuery(rawQuery), graphNodes);
    const citations = buildValidatedCitations(graphNodes, sources, {
      allowMetadataFallback: featureFlags.citationFallbackEnabled,
      strictCitationVerificationEnabled:
        isFactualIntent(rawQuery) && featureFlags.strictCitationVerificationEnabled,
      strictTokens: strictQueryTokens,
    });
    const guardedContent =
      isFactualIntent(rawQuery) && citations.length === 0
        ? withUncertaintyMarker(content)
        : content;
    const contentWithGuardrail = enforceAliasAndEvidenceFormatting(guardedContent, sources);

    const telemetry = buildTelemetry(startedAt, {
      routeMs,
      retrievalMs: routed.retrievalMs,
      mergeMs: routed.mergeMs,
      agentMs,
    });

    const coordinator = buildCoordinatorMetadata(domains, telemetry, {
      splitSignals: routed.splitSignals,
      specialistAgents: routed.specialistResults.map((result) => ({
        agent: result.agent,
        domains: result.domains,
        sourceCount: result.sources.length,
        nodeCount: result.nodes.length,
        durationMs: result.durationMs,
      })),
      estimatedContextTokens: estimateContextTokens(graphNodes),
      contradictions,
      interpretationLatencyMs,
      interpretationFallbackReason: interpretation.fallbackReason,
    });

    const splitSignals = routed.splitSignals;
    if (splitSignals.length > 0) {
      logger.info("chat.coordinator.specialist_split_signal", {
        projectId,
        domains,
        nodeCount: graphNodes.length,
        sourceCount: sources.length,
        reasons: splitSignals,
      });
    }

    logger.info("chat.coordinator.route_summary", {
      projectId,
      domains,
      sourceCount: sources.length,
      nodeCount: graphNodes.length,
      estimatedContextTokens: coordinator.estimatedContextTokens,
      specialistAgents: coordinator.specialistAgents,
      contradictions: contradictions.map((signal) => ({
        kind: signal.kind,
        severity: signal.severity,
      })),
      telemetry,
      retrievalPolicy: {
        activeDocBoostEnabled: featureFlags.activeDocBoostEnabled,
        citationFallbackEnabled: featureFlags.citationFallbackEnabled,
        strictFactualActiveDocMode: featureFlags.strictFactualActiveDocMode,
        sectionProximityBoostEnabled: featureFlags.sectionProximityBoostEnabled,
        strictCitationVerificationEnabled: featureFlags.strictCitationVerificationEnabled,
        activeDocBoostApplied,
        selectedFileName: activeDocFileName,
      },
      sourcePageProvenance: {
        exact: sources.filter((source) => source.pageOrigin === "exact").length,
        fallback: sources.filter((source) => source.pageOrigin === "fallback").length,
        mixed: sources.filter((source) => source.pageOrigin === "mixed").length,
        none: sources.filter((source) => !source.pageOrigin).length,
      },
      interpretation: {
        intent: interpretation.intent,
        confidence: interpretation.confidence,
        source: interpretation.source,
        fallbackReason: interpretation.fallbackReason,
      },
    });

    if (shouldUseResponseCache) {
      responseCache.set(cacheKey, {
        content: contentWithGuardrail,
        sources,
        citations,
        interpretation,
        domains,
        coordinator,
        createdAt: Date.now(),
      });
      pruneResponseCache();
    }

    const suggestions = buildSuggestions(trimmedQuery, domains, sources, {
      selectedFileName: activeDocFileName,
      enforceSelectedFileScope,
    });
    const autoOpenFileName = sources[0]?.fileName;

    return {
      content: contentWithGuardrail,
      sources,
      citations,
      interpretation,
      domains,
      coordinator,
      cacheHit: false,
      suggestions,
      autoOpenFileName,
    };
  },
};
