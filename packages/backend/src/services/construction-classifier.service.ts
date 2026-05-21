/**
 * Construction Classifier Service
 *
 * Rule-based + LLM-assisted classification of construction documents.
 * Assigns a ConstructionCategory and extracts key structured fields
 * (RFI number, submittal number, vendor, revision, dates, etc.).
 *
 * Rule-based classification runs first (fast, no cost).
 * LLM enrichment runs only for ambiguous documents when OpenAI is configured.
 */

import type { ConstructionCategory } from "../db/schema";
import { getEnv } from "../config/env";
import { logger } from "../lib/logger";

// ============================================================
// Extracted Fields
// ============================================================

export interface ExtractedConstructionFields {
  rfiNumber?: string;
  submittarNumber?: string;
  changeOrderNumber?: string;
  drawingNumber?: string;
  specSection?: string; // CSI format e.g. "03 30 00"
  sheetNumber?: string; // e.g. "A101"
  revision?: string; // e.g. "Rev 3" or "C"
  discipline?: string; // Architecture, Structural, MEP...
  vendor?: string;
  dateIssued?: string; // ISO date string
  dateRequired?: string;
  approvalStatus?: string; // Approved, Revise & Resubmit, Rejected, Pending
  costImpact?: string;
  scheduleImpact?: string;
  projectName?: string;
  contractNumber?: string;
  permitNumber?: string;
}

export interface ClassificationResult {
  category: ConstructionCategory;
  confidence: number; // 0-100
  extractedFields: ExtractedConstructionFields;
  tags: string[];
}

// ============================================================
// Keyword Rules
// ============================================================

interface CategoryRule {
  category: ConstructionCategory;
  weight: number;
  filenamePatterns: RegExp[];
  contentPatterns: RegExp[];
  folderPatterns: RegExp[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "rfi",
    weight: 10,
    filenamePatterns: [/\brfi[\s_\-#]?\d+/i, /request[\s_-]for[\s_-]information/i],
    contentPatterns: [
      /request\s+for\s+information/i,
      /\brfi\s*#?\s*\d+/i,
      /\bclause\b.*\brfi\b/i,
    ],
    folderPatterns: [/\brfi[s]?\b/i, /requests?[\s_-]for[\s_-]info/i],
  },
  {
    category: "submittal",
    weight: 10,
    filenamePatterns: [/submittal/i, /\bsub[\s_\-#]?\d+/i],
    contentPatterns: [/\bsubmittal\b/i, /\bsubmit\s+for\s+approval\b/i, /\bproduct\s+data\b/i],
    folderPatterns: [/submittals?/i],
  },
  {
    category: "change_order",
    weight: 10,
    filenamePatterns: [/change[\s_-]?order/i, /\bco[\s_\-#]?\d+\b/i, /\bpco\b/i, /\bpotential\s+change\b/i],
    contentPatterns: [/change\s+order\s*#/i, /\bpotential\s+change\s+order\b/i, /\bschedule\s+impact\b.*\bcost\s+impact\b/i],
    folderPatterns: [/change[\s_-]?orders?/i],
  },
  {
    category: "drawing",
    weight: 8,
    filenamePatterns: [/\b[a-z]\d{3}[a-z]?\b/i, /drawing/i, /\bdwg\b/i, /floor[\s_-]?plan/i],
    contentPatterns: [/scale\s+\d+:\d+/i, /\beach\s+sheet\b/i, /\bdimension\b/i],
    folderPatterns: [/drawings?/i, /plans?/i, /\bdwgs?\b/i],
  },
  {
    category: "spec",
    weight: 8,
    filenamePatterns: [/spec(ification)?s?/i, /\bdivision\s*\d+\b/i, /csi[\s_-]?section/i],
    contentPatterns: [/\bpart\s+1\b.*\bgeneral\b/i, /\bpart\s+2\b.*\bproducts?\b/i, /\bpart\s+3\b.*\bexecution\b/i, /\bsection\s+\d{2}\s+\d{2}\b/i],
    folderPatterns: [/specs?/i, /specifications?/i],
  },
  {
    category: "contract",
    weight: 9,
    filenamePatterns: [/contract/i, /agreement/i, /\bats\b/i, /\bgmp\b/i],
    contentPatterns: [/\bhereinafter\s+referred\b/i, /\bcontractor\s+shall\b/i, /\bowner\s+and\s+contractor\b/i],
    folderPatterns: [/contracts?/i, /agreements?/i],
  },
  {
    category: "schedule",
    weight: 9,
    filenamePatterns: [/schedule/i, /\bgantt\b/i, /\bbid\s+schedule\b/i, /\bbaseline[\s_]schedule\b/i],
    contentPatterns: [/\bcritical\s+path\b/i, /\bpredecessor\b/i, /\bstart\s+date\b.*\bfinish\s+date\b/i, /\blook[\s_-]ahead\b/i],
    folderPatterns: [/schedules?/i],
  },
  {
    category: "meeting_minutes",
    weight: 7,
    filenamePatterns: [/meeting[\s_-]?minutes?/i, /\bmom\b/i, /\bsite[\s_-]?meeting\b/i],
    contentPatterns: [/\battendees?\b/i, /\baction\s+items?\b/i, /\bminutes\s+of\s+meeting\b/i],
    folderPatterns: [/meeting[\s_-]?minutes?/i, /\bmeetings?\b/i],
  },
  {
    category: "permit",
    weight: 9,
    filenamePatterns: [/permit/i, /\bbp[\s_\-#]?\d+\b/i, /\bnotice\s+to\s+proceed\b/i],
    contentPatterns: [/\bbuilding\s+permit\b/i, /\bpermit\s+number\b/i, /\binspection\s+required\b/i],
    folderPatterns: [/permits?/i],
  },
  {
    category: "invoice",
    weight: 8,
    filenamePatterns: [/invoice/i, /\binv[\s_\-#]?\d+\b/i, /\bpay\s+app\b/i, /\bapplication[\s_-]for[\s_-]payment\b/i],
    contentPatterns: [/\binvoice\s+#/i, /\btotal\s+amount\s+due\b/i, /\bnet\s+\d+\s+days\b/i, /\bapplication\s+for\s+payment\b/i],
    folderPatterns: [/invoices?/i, /pay[\s_-]?apps?/i],
  },
  {
    category: "safety",
    weight: 7,
    filenamePatterns: [/safety/i, /\bjha\b/i, /\bmsds\b/i, /\bsds\b/i, /\bswp\b/i, /toolbox[\s_-]?talk/i],
    contentPatterns: [/\bjob\s+hazard\s+analysis\b/i, /\bhazard\s+identification\b/i, /\bppe\b/i, /\bsafety\s+data\s+sheet\b/i],
    folderPatterns: [/safety/i, /\bswp\b/i],
  },
  {
    category: "photo",
    weight: 6,
    filenamePatterns: [/\.(jpg|jpeg|png|heic|tiff?|bmp|gif)$/i, /photo/i, /\bsite[\s_-]?photo\b/i],
    contentPatterns: [],
    folderPatterns: [/photos?/i, /images?/i, /site[\s_-]?photos?/i],
  },
  {
    category: "correspondence",
    weight: 5,
    filenamePatterns: [/letter/i, /transmittal/i, /\bemail\b/i, /\.(msg|eml)$/i],
    contentPatterns: [/\bdear\s+\w+/i, /\bsincerely\b/i, /\bregards\b/i],
    folderPatterns: [/correspondence/i, /letters?/i, /transmittals?/i],
  },
];

// ============================================================
// Field Extraction Patterns
// ============================================================

const FIELD_PATTERNS = {
  rfiNumber: /rfi\s*#?\s*(\d+)/i,
  submittarNumber: /submittal\s*#?\s*([\w-]+)/i,
  changeOrderNumber: /(?:change\s+order|pco)\s*#?\s*([\w-]+)/i,
  drawingNumber: /(?:drawing|dwg)\s*#?\s*([\w-]+)/i,
  specSection: /section\s+(\d{2}\s+\d{2}\s+\d{2})/i,
  sheetNumber: /\bsheet\s*#?\s*([a-z]\d{3}[a-z]?)/i,
  revision: /rev(?:ision)?\s*[.:]?\s*([a-z\d]+)/i,
  vendor: /(?:submitted\s+by|vendor|manufacturer|supplier)\s*[:\-]?\s*([A-Z][A-Za-z\s]{3,30})/,
  approvalStatus: /(approved|revise\s+and\s+resubmit|rejected|pending|for\s+construction|for\s+record\s+only)/i,
  costImpact: /cost\s+impact\s*[:\-]?\s*(\$?[\d,]+(?:\.\d{2})?)/i,
  permitNumber: /permit\s*#?\s*([\w-]+)/i,
};

// ============================================================
// Rule-based Classifier
// ============================================================

function scoreCategories(fileName: string, filePath: string, textSample: string): Map<ConstructionCategory, number> {
  const scores = new Map<ConstructionCategory, number>();
  const lowerName = fileName.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  const lowerText = textSample.toLowerCase().slice(0, 3000);

  for (const rule of CATEGORY_RULES) {
    let score = 0;

    for (const pattern of rule.filenamePatterns) {
      if (pattern.test(lowerName)) score += rule.weight * 3;
    }
    for (const pattern of rule.folderPatterns) {
      if (pattern.test(lowerPath)) score += rule.weight * 2;
    }
    for (const pattern of rule.contentPatterns) {
      if (pattern.test(lowerText)) score += rule.weight;
    }

    if (score > 0) {
      scores.set(rule.category, (scores.get(rule.category) ?? 0) + score);
    }
  }

  return scores;
}

function extractFields(text: string): ExtractedConstructionFields {
  const fields: ExtractedConstructionFields = {};

  for (const [key, pattern] of Object.entries(FIELD_PATTERNS)) {
    const match = text.match(pattern);
    if (match?.[1]) {
      (fields as Record<string, string>)[key] = match[1].trim();
    }
  }

  return fields;
}

function pickTopCategory(scores: Map<ConstructionCategory, number>): { category: ConstructionCategory; confidence: number } {
  if (scores.size === 0) {
    return { category: "unknown", confidence: 0 };
  }

  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const [topCategory, topScore] = sorted[0];
  const secondScore = sorted[1]?.[1] ?? 0;

  // Confidence = how much the top score dominates
  const total = Array.from(scores.values()).reduce((a, b) => a + b, 0);
  const rawConfidence = total > 0 ? Math.round((topScore / total) * 100) : 0;

  // Gap between top and second reduces confidence (ambiguous)
  const gap = topScore - secondScore;
  const gapBonus = Math.min(20, Math.round(gap * 2));

  const confidence = Math.min(95, rawConfidence + gapBonus);

  return { category: topCategory as ConstructionCategory, confidence };
}

function deriveTagsFromCategory(category: ConstructionCategory, fields: ExtractedConstructionFields): string[] {
  const tags: string[] = [category];
  if (fields.rfiNumber) tags.push("rfi", `rfi-${fields.rfiNumber}`);
  if (fields.submittarNumber) tags.push("submittal");
  if (fields.changeOrderNumber) tags.push("change-order");
  if (fields.discipline) tags.push(fields.discipline.toLowerCase());
  if (fields.approvalStatus) tags.push(fields.approvalStatus.toLowerCase().replace(/\s+/g, "-"));
  return [...new Set(tags)];
}

// ============================================================
// LLM Enrichment (runs only when OpenAI is configured + low confidence)
// ============================================================

const LLM_CONFIDENCE_THRESHOLD = 40;

const CATEGORY_LIST = [
  "drawing", "rfi", "submittal", "change_order", "contract",
  "schedule", "spec", "meeting_minutes", "permit", "invoice",
  "safety", "photo", "report", "correspondence", "unknown",
].join(", ");

async function enrichWithLlm(
  fileName: string,
  textSample: string,
  currentCategory: ConstructionCategory
): Promise<Partial<ClassificationResult>> {
  const env = getEnv();
  if (!env.openAiApiKey || !env.openAiChatEndpoint) return {};

  const prompt = `You are a construction document classifier. Analyze this document and respond with JSON only.

File name: ${fileName}
Document excerpt (first 800 chars):
${textSample.slice(0, 800)}

Current best-guess category: ${currentCategory}

Respond with this JSON schema (no markdown, just raw JSON):
{
  "category": "<one of: ${CATEGORY_LIST}>",
  "confidence": <0-100>,
  "rfiNumber": "<or null>",
  "submittarNumber": "<or null>",
  "changeOrderNumber": "<or null>",
  "drawingNumber": "<or null>",
  "specSection": "<CSI section or null>",
  "revision": "<or null>",
  "vendor": "<or null>",
  "approvalStatus": "<or null>",
  "costImpact": "<or null>",
  "scheduleImpact": "<or null>",
  "discipline": "<Architecture|Structural|MEP|Civil|Landscape|or null>"
}`;

  try {
    const response = await fetch(env.openAiChatEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: env.openAiChatModel ?? "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 400,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) return {};

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = payload.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as Record<string, string | number | null>;

    const fields: ExtractedConstructionFields = {};
    for (const key of Object.keys(FIELD_PATTERNS)) {
      const val = parsed[key];
      if (val && typeof val === "string") (fields as Record<string, string>)[key] = val;
    }
    if (parsed.scheduleImpact && typeof parsed.scheduleImpact === "string") {
      fields.scheduleImpact = parsed.scheduleImpact;
    }
    if (parsed.discipline && typeof parsed.discipline === "string") {
      fields.discipline = parsed.discipline;
    }

    return {
      category: (parsed.category as ConstructionCategory) ?? currentCategory,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      extractedFields: fields,
    };
  } catch {
    return {};
  }
}

// ============================================================
// Public API
// ============================================================

export const constructionClassifierService = {
  /**
   * Classify a file and extract construction-specific fields.
   *
   * @param fileName  - The file's base name (e.g. "RFI-042.pdf")
   * @param filePath  - Full path inside the project (for folder context)
   * @param textSample - First ~3000 chars of extracted text (or empty for images)
   */
  async classify(
    fileName: string,
    filePath: string,
    textSample: string
  ): Promise<ClassificationResult> {
    // Stage 1: Rule-based classification
    const scores = scoreCategories(fileName, filePath, textSample);
    const { category, confidence } = pickTopCategory(scores);
    const extractedFields = extractFields(textSample);

    // Stage 2: LLM enrichment if confidence is low and API is available
    if (confidence < LLM_CONFIDENCE_THRESHOLD) {
      try {
        const llmResult = await enrichWithLlm(fileName, textSample, category);

        const finalCategory = llmResult.category ?? category;
        const finalConfidence = llmResult.confidence ?? confidence;
        const finalFields = { ...extractedFields, ...(llmResult.extractedFields ?? {}) };

        const llmEnriched =
          llmResult.category !== undefined ||
          llmResult.confidence !== undefined ||
          (llmResult.extractedFields !== undefined &&
            Object.keys(llmResult.extractedFields).length > 0);

        if (llmEnriched) {
          logger.info("construction-classifier.llm.used", { fileName, category: finalCategory });
        }

        return {
          category: finalCategory,
          confidence: finalConfidence,
          extractedFields: finalFields,
          tags: deriveTagsFromCategory(finalCategory, finalFields),
        };
      } catch (err) {
        logger.warn("construction-classifier.llm.failed", {
          fileName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      category,
      confidence,
      extractedFields,
      tags: deriveTagsFromCategory(category, extractedFields),
    };
  },
};
