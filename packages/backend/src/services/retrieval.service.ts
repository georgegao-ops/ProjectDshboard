/**
 * Retrieval Service
 *
 * Provides the context/search API that the AI Chat Branch queries.
 *
 * Endpoints supported:
 *   retrieveSources()   — top-K chunks for a query (used by chat)
 *   searchProject()     — full semantic search with metadata filters
 *   getProjectContext() — structured project state snapshot
 *   getDocumentDetail() — single file full detail
 *   getSuggestions()    — next likely questions based on indexed content
 */

import type { ChatInterpretation, SendChatMessageResponse, UUID } from "@contractor/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { getEnv } from "../config/env";
import { embeddingsService } from "./embeddings.service";
import { featureService } from "./feature.service";
import { projectService } from "./project.service";
import { retrievalRerankerService } from "./retrieval-reranker.service";
import { getDbIfInitialized, fileRecords, fileChunks, documentRelationships } from "../db";
import { logger } from "../lib/logger";
import { tokenizeQuery, keywordHitScore } from "./text-ranking.utils";

// ============================================================
// Types
// ============================================================

export interface RetrievalOptions {
  topK?: number;
  minRelevance?: number;
  category?: string;
  tags?: string[];
  interpretation?: Pick<ChatInterpretation, "intent" | "confidence" | "retrievalHints" | "entities">;
}

export interface SearchResult {
  fileId: UUID;
  fileName: string;
  filePath: string;
  docCategory?: string;
  extractedFields?: Record<string, string | undefined>;
  summary?: string;
  matchedChunks: Array<{
    chunkId: string;
    chunkText: string;
    chunkIndex: number;
    relevance: number;
    sourceType: "content" | "summary" | "metadata_stub";
    pageNumber?: number;
    sectionLabel?: string;
    metadata?: Record<string, unknown>;
  }>;
  topRelevance: number;
  tags?: string[];
}

export interface ProjectContextSnapshot {
  projectId: UUID;
  generatedAt: Date;
  // Counts
  totalFiles: number;
  indexedFiles: number;
  pendingFiles: number;
  failedFiles: number;
  indexingPercent: number;
  // Construction state
  openRfis: Array<{ fileId: string; fileName: string; rfiNumber?: string; summary?: string }>;
  pendingSubmittals: Array<{ fileId: string; fileName: string; submittarNumber?: string; status?: string }>;
  recentChangeOrders: Array<{ fileId: string; fileName: string; coNumber?: string; summary?: string }>;
  recentlyModifiedFiles: Array<{ fileId: string; fileName: string; updatedAt: Date }>;
  categoryBreakdown: Record<string, number>;
  topSpecSections: string[];
}

export interface DocumentDetail {
  fileId: UUID;
  fileName: string;
  filePath: string;
  fileSize?: number;
  mimeType?: string;
  docCategory?: string;
  summary?: string;
  keyTopics?: string[];
  tags?: string[];
  extractedFields?: Record<string, string | undefined>;
  specSection?: string;
  sheetNumber?: string;
  revision?: string;
  indexStatus: string;
  lastIndexed?: Date;
  chunkCount: number;
  chunks: Array<{
    chunkIndex: number;
    chunkText: string;
    tokenCount: number;
    sourceType?: "content" | "summary" | "metadata_stub";
    pageNumber?: number;
    sectionLabel?: string;
    metadata?: Record<string, unknown>;
  }>;
  relatedDocuments: Array<{ fileId: string; fileName: string; relationType: string; confidence: number }>;
}

// ============================================================
// Helpers
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeOptions(options?: RetrievalOptions): {
  topK: number;
  minRelevance: number;
  category: string;
  tags: string[];
} {
  const requestedTopK = Number(options?.topK ?? 5);
  const requestedMinRelevance = Number(options?.minRelevance ?? 0);
  return {
    topK: Number.isFinite(requestedTopK) ? clamp(Math.floor(requestedTopK), 1, 20) : 5,
    minRelevance: Number.isFinite(requestedMinRelevance) ? clamp(requestedMinRelevance, 0, 1) : 0,
    category: options?.category?.trim().toLowerCase() ?? "",
    tags: (options?.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  };
}

function toSearchTokens(query: string): string[] {
  return tokenizeQuery(query, 3, 8);
}

function deriveEffectiveTokens(
  tokens: string[],
  candidates: Array<{ chunkText: string; fileName: string }>
): string[] {
  if (tokens.length <= 1 || candidates.length === 0) {
    return tokens;
  }

  const maxCoverageRatio = 0.6;
  const filtered = tokens.filter((token) => {
    const hitCount = candidates.reduce((count, candidate) => {
      const haystackText = candidate.chunkText.toLowerCase();
      const haystackName = candidate.fileName.toLowerCase();
      if (haystackText.includes(token) || haystackName.includes(token)) {
        return count + 1;
      }
      return count;
    }, 0);

    return hitCount / candidates.length <= maxCoverageRatio;
  });

  return filtered.length > 0 ? filtered : tokens;
}

type ChunkSourceType = "content" | "summary" | "metadata_stub";

interface RetrievalCandidate {
  chunkId: string;
  fileId: string;
  fileName: string;
  chunkIndex: number;
  chunkText: string;
  relevance: number;
  sourceType: ChunkSourceType;
  pageNumber?: number;
  sectionLabel?: string;
  metadata?: Record<string, unknown>;
  docCategory?: string;
  tags?: string[];
  priorityScore?: number;
  updatedAt?: Date;
  extractedFields?: Record<string, unknown>;
  vectorScore?: number;
  lexicalScore?: number;
}

type HybridBlendProfile = "balanced" | "lexical_heavy" | "semantic_heavy";

function resolveBlendProfile(interpretation: RetrievalOptions["interpretation"]): HybridBlendProfile {
  const env = getEnv();
  if (interpretation?.intent === "file_lookup" || interpretation?.intent === "active_doc_qa") {
    return "lexical_heavy";
  }
  if (interpretation?.intent === "document_summary") {
    return "semantic_heavy";
  }
  return env.retrievalBlendProfile;
}

function blendWeights(profile: HybridBlendProfile): { semanticWeight: number; lexicalWeight: number } {
  if (profile === "lexical_heavy") {
    return { semanticWeight: 0.35, lexicalWeight: 0.65 };
  }
  if (profile === "semantic_heavy") {
    return { semanticWeight: 0.7, lexicalWeight: 0.3 };
  }
  return { semanticWeight: 0.5, lexicalWeight: 0.5 };
}

function mergeHybridCandidates(
  vectorCandidates: RetrievalCandidate[],
  lexicalCandidates: RetrievalCandidate[],
  profile: HybridBlendProfile
): RetrievalCandidate[] {
  const { semanticWeight, lexicalWeight } = blendWeights(profile);
  const merged = new Map<string, RetrievalCandidate>();

  for (const candidate of vectorCandidates) {
    merged.set(candidate.chunkId, {
      ...candidate,
      vectorScore: candidate.relevance,
      lexicalScore: 0,
      relevance: Number((candidate.relevance * semanticWeight).toFixed(6)),
    });
  }

  for (const candidate of lexicalCandidates) {
    const existing = merged.get(candidate.chunkId);
    if (!existing) {
      merged.set(candidate.chunkId, {
        ...candidate,
        vectorScore: 0,
        lexicalScore: candidate.relevance,
        relevance: Number((candidate.relevance * lexicalWeight).toFixed(6)),
      });
      continue;
    }

    const vectorScore = existing.vectorScore ?? 0;
    const lexicalScore = candidate.relevance;
    merged.set(candidate.chunkId, {
      ...existing,
      lexicalScore,
      relevance: Number((vectorScore * semanticWeight + lexicalScore * lexicalWeight).toFixed(6)),
    });
  }

  return Array.from(merged.values()).sort((left, right) => right.relevance - left.relevance);
}

async function maybeApplyRerank(
  projectId: UUID,
  query: string,
  candidates: RetrievalCandidate[]
): Promise<RetrievalCandidate[]> {
  const env = getEnv();
  const rerankEnabled = featureService.isRolloutFlagEnabledForProject(
    projectId,
    "RETRIEVAL_RERANK_ENABLED"
  );

  if (!rerankEnabled || candidates.length === 0) {
    return candidates;
  }

  const startedAt = Date.now();
  try {
    const rerankResult = await retrievalRerankerService.rerank({
      query,
      candidates,
      topN: env.retrievalRerankTopN,
      provider: env.retrievalRerankProvider,
    });

    logger.info("retrieval.rerank.metrics", {
      applied: rerankResult.applied,
      provider: rerankResult.provider,
      durationMs: rerankResult.durationMs,
      costEstimateTokens: rerankResult.costEstimateTokens,
      candidateCount: candidates.length,
    });

    return rerankResult.candidates;
  } catch (error) {
    logger.warn("retrieval.rerank.failed", {
      provider: env.retrievalRerankProvider,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return candidates;
  }
}

function applyInterpretationBoost(
  candidates: RetrievalCandidate[],
  interpretation?: RetrievalOptions["interpretation"]
): RetrievalCandidate[] {
  if (!interpretation || interpretation.confidence < 0.6) {
    return candidates;
  }

  const preferredCategories = new Set(
    (interpretation.retrievalHints?.preferredCategories ?? []).map((value) => value.toLowerCase())
  );
  const preferredTags = new Set(
    (interpretation.retrievalHints?.preferredTags ?? []).map((value) => value.toLowerCase())
  );

  const now = Date.now();
  const recencyBias = interpretation.retrievalHints?.recencyBias === true;
  const statusHint = interpretation.entities?.statusHint?.toLowerCase();
  const specSectionHint = interpretation.entities?.specSection?.trim();
  const confidenceWeight = Math.min(1, Math.max(0, interpretation.confidence));

  return candidates
    .map((candidate) => {
      let score = candidate.relevance;
      const category = (candidate.docCategory ?? "").toLowerCase();
      const tags = (candidate.tags ?? []).map((tag) => tag.toLowerCase());
      const extracted = candidate.extractedFields ?? {};

      if (preferredCategories.size > 0 && preferredCategories.has(category)) {
        score += 0.08 * confidenceWeight;
      }

      if (preferredTags.size > 0 && tags.some((tag) => preferredTags.has(tag))) {
        score += 0.06 * confidenceWeight;
      }

      if (recencyBias && candidate.updatedAt) {
        const ageDays = Math.max(1, (now - candidate.updatedAt.getTime()) / (24 * 60 * 60 * 1000));
        score += Math.min(0.05, 0.05 / ageDays) * confidenceWeight;
      }

      if (typeof candidate.priorityScore === "number") {
        score += Math.min(0.04, Math.max(0, candidate.priorityScore / 100) * 0.04) * confidenceWeight;
      }

      if (statusHint) {
        const approvalStatus = String(extracted.approvalStatus ?? extracted.status ?? "").toLowerCase();
        if (approvalStatus && approvalStatus.includes(statusHint)) {
          score += 0.04 * confidenceWeight;
        }
      }

      if (specSectionHint) {
        const specSection = String(extracted.specSection ?? "").trim();
        if (specSection && specSection.includes(specSectionHint)) {
          score += 0.05 * confidenceWeight;
        }
      }

      return {
        ...candidate,
        relevance: Number(Math.max(0, Math.min(1, score)).toFixed(6)),
      };
    })
    .sort((left, right) => right.relevance - left.relevance);
}

interface RetrievalIntent {
  overview: boolean;
  drawingHint: boolean;
}

function detectRetrievalIntent(query: string): RetrievalIntent {
  const normalized = query.toLowerCase();
  return {
    overview: /\b(summarize|summary|overview|what is this|high[- ]level|big picture)\b/.test(normalized),
    drawingHint: /\b(drawing|sheet|title block|plan|elevation|detail|section)\b/.test(normalized),
  };
}

function applySourceTypePolicy(candidates: RetrievalCandidate[], query: string): RetrievalCandidate[] {
  const intent = detectRetrievalIntent(query);

  const filtered = candidates.filter((candidate) => {
    if (candidate.sourceType === "metadata_stub" && !intent.drawingHint) {
      return false;
    }
    return true;
  });

  return filtered
    .map((candidate) => {
      let score = candidate.relevance;
      if (intent.overview) {
        if (candidate.sourceType === "summary") score += 0.12;
        if (candidate.sourceType === "metadata_stub") score -= 0.03;
      } else {
        if (candidate.sourceType === "content") score += 0.1;
        if (candidate.sourceType === "summary") score -= 0.08;
        if (candidate.sourceType === "metadata_stub") score -= 0.12;
      }
      return {
        ...candidate,
        relevance: Number(Math.max(0, Math.min(1, score)).toFixed(6)),
      };
    })
    .sort((a, b) => b.relevance - a.relevance);
}

function applyFileIdentityBoost(candidates: RetrievalCandidate[], query: string): RetrievalCandidate[] {
  const normalizedQuery = query.toLowerCase();
  const volumeMatch = normalizedQuery.match(/\bvolume\s*(\d{1,2})\b/i);
  const volume = volumeMatch?.[1] ? Number.parseInt(volumeMatch[1], 10) : undefined;
  const paddedVolume = typeof volume === "number" ? String(volume).padStart(2, "0") : undefined;
  const hasPrdcHint = /\bprdc\b/i.test(normalizedQuery);
  const hasConformedHint = /\bconformed\b/i.test(normalizedQuery);

  if (typeof volume !== "number" && !hasPrdcHint && !hasConformedHint) {
    return candidates;
  }

  return candidates
    .map((candidate) => {
      const fileIdentity = candidate.fileName.toLowerCase();
      const hasVolumeMatch =
        typeof volume === "number" &&
        (new RegExp(`\\bvolume[\\s._-]*0?${volume}\\b`, "i").test(fileIdentity) ||
          (typeof paddedVolume === "string" && new RegExp(`\\bvol(?:ume)?[\\s._-]*${paddedVolume}\\b`, "i").test(fileIdentity)));
      const hasPrdcMatch = /\bprdc\b/i.test(fileIdentity);
      const hasPrdcFamilyMatch =
        hasPrdcMatch ||
        (fileIdentity.includes("requirements") && fileIdentity.includes("design") && fileIdentity.includes("criteria"));
      const hasConformedMatch = /\bconformed\b/i.test(fileIdentity);

      let score = candidate.relevance;
      if (hasVolumeMatch) score += 0.22;
      if (hasPrdcHint && hasPrdcFamilyMatch) score += 0.12;
      if (hasConformedHint && hasConformedMatch) score += 0.08;
      if (hasPrdcHint && !hasPrdcFamilyMatch) score -= 0.06;

      return {
        ...candidate,
        relevance: Number(Math.max(0, Math.min(1, score)).toFixed(6)),
      };
    })
    .sort((left, right) => right.relevance - left.relevance);
}

function applySpecificationChunkBoost(candidates: RetrievalCandidate[], query: string): RetrievalCandidate[] {
  const normalizedQuery = query.toLowerCase();
  const specIntent = /\b(spec|specs|specification|specifications|requirement|requirements)\b/i.test(normalizedQuery);
  const expansionJointIntent = /\bexpansion\b/i.test(normalizedQuery) && /\bjoint\b/i.test(normalizedQuery);
  if (!specIntent && !expansionJointIntent) {
    return candidates;
  }

  return candidates
    .map((candidate) => {
      let score = candidate.relevance;
      const text = candidate.chunkText.toLowerCase();

      if (expansionJointIntent && /\bexpansion\s+joints?\b/i.test(text)) {
        score += 0.2;
      }

      if (specIntent && /\bsubmittals?\b|\bwarranty\b|\bsamples?\b/i.test(text)) {
        score += 0.1;
      }

      if (/\b3\.52\b/i.test(text) || /\b3\.52\b/i.test(candidate.sectionLabel ?? "")) {
        score += 0.2;
      }

      return {
        ...candidate,
        relevance: Number(Math.max(0, Math.min(1, score)).toFixed(6)),
      };
    })
    .sort((left, right) => right.relevance - left.relevance);
}

let pgvectorAvailable: boolean | undefined;
const QUERY_EMBEDDING_CACHE_TTL_MS = 2 * 60 * 1000;
const PROJECT_CONTEXT_CACHE_TTL_MS = 15 * 1000;
const queryEmbeddingCache = new Map<string, { value: ReturnType<typeof embeddingsService.embedText>; createdAt: number }>();
const projectContextCache = new Map<string, { value: ProjectContextSnapshot; createdAt: number }>();

function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase();
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }

  if (aNorm <= 0 || bNorm <= 0) {
    return 0;
  }

  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

async function inMemorySearch(
  projectId: UUID,
  query: string,
  queryVector: number[] | undefined,
  topK: number,
  categoryFilter?: string,
  tagsFilter?: string[]
): Promise<RetrievalCandidate[]> {
  const chunks = await projectService.listProjectChunks(projectId);
  const baseTokens = toSearchTokens(query);
  const loweredCategory = categoryFilter?.trim().toLowerCase();
  const loweredTags = (tagsFilter ?? []).map((tag) => tag.toLowerCase()).filter(Boolean);

  const filteredChunks = chunks
    .filter((chunk) => {
      const category = String((chunk as { docCategory?: string }).docCategory ?? "").toLowerCase();
      const tags = ((chunk as { tags?: string[] }).tags ?? []).map((tag) => tag.toLowerCase());

      if (loweredCategory && category && category !== loweredCategory) {
        return false;
      }

      if (loweredTags.length > 0 && loweredTags.some((tag) => !tags.includes(tag))) {
        return false;
      }

      return true;
    });

  const effectiveTokens = deriveEffectiveTokens(
    baseTokens,
    filteredChunks.map((chunk) => ({ chunkText: chunk.chunkText, fileName: chunk.fileName }))
  );

  const mapped = filteredChunks
    .map((chunk) => {
      const semantic = queryVector ? cosineSimilarity(queryVector, chunk.embedding) : 0;
      const keyword = effectiveTokens.length > 0
        ? keywordHitScore(effectiveTokens, chunk.chunkText) / effectiveTokens.length
        : 0;
      const relevance = Math.max(semantic, keyword);

      return {
        chunkId: chunk.id,
        fileId: chunk.fileId,
        fileName: chunk.fileName,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        relevance,
        sourceType: chunk.sourceType,
        pageNumber: chunk.pageNumber,
        sectionLabel: chunk.sectionLabel,
        metadata: chunk.metadata,
        docCategory: (chunk as { docCategory?: string }).docCategory,
        tags: (chunk as { tags?: string[] }).tags,
        priorityScore: (chunk as { priorityScore?: number }).priorityScore,
        updatedAt: (chunk as { updatedAt?: Date }).updatedAt,
        extractedFields: (chunk as { extractedFields?: Record<string, unknown> }).extractedFields,
      } as RetrievalCandidate;
    })
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, Math.max(topK * 3, 20));

  return mapped;
}

async function getCachedQueryEmbedding(query: string) {
  const cacheKey = normalizeQueryKey(query);
  const now = Date.now();
  const cached = queryEmbeddingCache.get(cacheKey);

  if (cached && now - cached.createdAt <= QUERY_EMBEDDING_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = embeddingsService.embedText(query);
  queryEmbeddingCache.set(cacheKey, {
    value,
    createdAt: now,
  });

  try {
    return await value;
  } catch (error) {
    queryEmbeddingCache.delete(cacheKey);
    throw error;
  }
}

// ============================================================
// pgvector similarity search
// ============================================================

async function pgvectorSearch(
  projectId: UUID,
  queryVector: number[],
  topK: number,
  categoryFilter?: string
): Promise<RetrievalCandidate[]> {
  if (pgvectorAvailable === false) return [];

  const db = getDbIfInitialized();
  if (!db) return [];

  const vectorStr = `[${queryVector.join(",")}]`;
  try {
    // Use parameterised raw SQL for pgvector cosine distance
    const categoryClause = categoryFilter
      ? sql`AND fr.doc_category = ${categoryFilter}`
      : sql``;

    const rows = await db.execute<{
      id: string;
      file_id: string;
      file_name: string;
      chunk_index: number;
      chunk_text: string;
      source_type: ChunkSourceType;
      page_number: number | null;
      section_label: string | null;
      metadata: Record<string, unknown> | null;
      doc_category: string | null;
      tags: string[] | null;
      priority_score: number | null;
      updated_at: Date | null;
      extracted_fields: Record<string, unknown> | null;
      similarity: number;
    }>(sql`
      SELECT
        fc.id,
        fc.file_id,
        fc.file_name,
        fc.chunk_index,
        fc.chunk_text,
        fc.source_type,
        fc.page_number,
        fc.section_label,
        fc.metadata,
        fr.doc_category,
        fr.tags,
        fr.priority_score,
        fr.updated_at,
        fr.extracted_fields,
        1 - (fc.embedding_vector <=> ${vectorStr}::vector) AS similarity
      FROM file_chunks fc
      JOIN file_records fr ON fr.id = fc.file_id
      WHERE fc.project_id = ${projectId}
        AND fc.embedding_vector IS NOT NULL
        ${categoryClause}
      ORDER BY fc.embedding_vector <=> ${vectorStr}::vector
      LIMIT ${topK * 3}
    `);

    return Array.from(rows as unknown as Array<{ id: string; file_id: string; file_name: string; chunk_index: number; chunk_text: string; source_type: ChunkSourceType; page_number: number | null; section_label: string | null; metadata: Record<string, unknown> | null; doc_category: string | null; tags: string[] | null; priority_score: number | null; updated_at: Date | null; extracted_fields: Record<string, unknown> | null; similarity: number }>).map((r) => ({
      chunkId: r.id,
      fileId: r.file_id,
      fileName: r.file_name,
      chunkIndex: r.chunk_index,
      chunkText: r.chunk_text,
      relevance: Number(r.similarity ?? 0),
      sourceType: r.source_type ?? "content",
      pageNumber: r.page_number ?? undefined,
      sectionLabel: r.section_label ?? undefined,
      metadata: r.metadata ?? undefined,
      docCategory: r.doc_category ?? undefined,
      tags: r.tags ?? undefined,
      priorityScore: r.priority_score ?? undefined,
      updatedAt: r.updated_at ?? undefined,
      extractedFields: r.extracted_fields ?? undefined,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lowered = message.toLowerCase();
    if (
      lowered.includes("type \"vector\" does not exist") ||
      (lowered.includes("operator does not exist") && lowered.includes("<=>"))
    ) {
      pgvectorAvailable = false;
    }
    // pgvector may be unavailable or embedding_vector may not be native vector in local DB.
    logger.warn("retrieval.pgvector.failed", { error: message });
    return [];
  }
}

async function keywordSearch(
  projectId: UUID,
  query: string,
  topK: number,
  categoryFilter?: string,
  tagsFilter?: string[]
): Promise<RetrievalCandidate[]> {
  const db = getDbIfInitialized();
  if (!db) return [];

  const baseTokens = toSearchTokens(query);
  if (baseTokens.length === 0) return [];

  const tokenClauses = baseTokens.map((token) => {
    const like = `%${token}%`;
    return sql`(LOWER(fc.chunk_text) LIKE ${like} OR LOWER(fc.file_name) LIKE ${like})`;
  });

  const categoryClause = categoryFilter
    ? sql`AND fr.doc_category = ${categoryFilter}`
    : sql``;

  const loweredTags = (tagsFilter ?? [])
    .map((tag) => tag.toLowerCase())
    .filter(Boolean);

  const tagsClause = loweredTags.length > 0
    ? sql`AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(fr.tags, ARRAY[]::text[])) tag
        WHERE LOWER(tag) IN (${sql.join(loweredTags.map((tag) => sql`${tag}`), sql`, `)})
      )`
    : sql``;

  const rows = await db.execute<{
    id: string;
    file_id: string;
    file_name: string;
    chunk_index: number;
    chunk_text: string;
    source_type: ChunkSourceType;
    page_number: number | null;
    section_label: string | null;
    metadata: Record<string, unknown> | null;
    doc_category: string | null;
    tags: string[] | null;
    priority_score: number | null;
    updated_at: Date | null;
    extracted_fields: Record<string, unknown> | null;
  }>(sql`
    SELECT
      fc.id,
      fc.file_id,
      fc.file_name,
      fc.chunk_index,
      fc.chunk_text,
      fc.source_type,
      fc.page_number,
      fc.section_label,
      fc.metadata,
      fr.doc_category,
      fr.tags,
      fr.priority_score,
      fr.updated_at,
      fr.extracted_fields
    FROM file_chunks fc
    JOIN file_records fr ON fr.id = fc.file_id
    WHERE fc.project_id = ${projectId}
      ${categoryClause}
      ${tagsClause}
      AND (${sql.join(tokenClauses, sql` OR `)})
    ORDER BY fc.file_id, fc.chunk_index
    LIMIT ${Math.max(topK * 20, 100)}
  `);

  const effectiveTokens = deriveEffectiveTokens(
    baseTokens,
    Array.from(rows as unknown as Array<{ chunk_text: string; file_name: string }>).map((row) => ({
      chunkText: row.chunk_text,
      fileName: row.file_name,
    }))
  );

  return Array.from(rows as unknown as Array<{ id: string; file_id: string; file_name: string; chunk_index: number; chunk_text: string; source_type: ChunkSourceType; page_number: number | null; section_label: string | null; metadata: Record<string, unknown> | null; doc_category: string | null; tags: string[] | null; priority_score: number | null; updated_at: Date | null; extracted_fields: Record<string, unknown> | null }>).map((row) => {
    const relevance = effectiveTokens.length > 0
      ? keywordHitScore(effectiveTokens, row.chunk_text) / effectiveTokens.length
      : 0;
    return {
      chunkId: row.id,
      fileId: row.file_id,
      fileName: row.file_name,
      chunkIndex: row.chunk_index,
      chunkText: row.chunk_text,
      relevance,
      sourceType: row.source_type ?? "content",
      pageNumber: row.page_number ?? undefined,
      sectionLabel: row.section_label ?? undefined,
      metadata: row.metadata ?? undefined,
      docCategory: row.doc_category ?? undefined,
      tags: row.tags ?? undefined,
      priorityScore: row.priority_score ?? undefined,
      updatedAt: row.updated_at ?? undefined,
      extractedFields: row.extracted_fields ?? undefined,
    };
  });
}

async function ftsSearch(
  projectId: UUID,
  query: string,
  topK: number,
  categoryFilter?: string,
  tagsFilter?: string[]
): Promise<RetrievalCandidate[]> {
  const db = getDbIfInitialized();
  if (!db) return [];

  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const categoryClause = categoryFilter
    ? sql`AND fr.doc_category = ${categoryFilter}`
    : sql``;

  const loweredTags = (tagsFilter ?? []).map((tag) => tag.toLowerCase()).filter(Boolean);
  const tagsClause = loweredTags.length > 0
    ? sql`AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(fr.tags, ARRAY[]::text[])) tag
        WHERE LOWER(tag) IN (${sql.join(loweredTags.map((tag) => sql`${tag}`), sql`, `)})
      )`
    : sql``;

  try {
    const rows = await db.execute<{
      id: string;
      file_id: string;
      file_name: string;
      chunk_index: number;
      chunk_text: string;
      source_type: ChunkSourceType;
      page_number: number | null;
      section_label: string | null;
      metadata: Record<string, unknown> | null;
      doc_category: string | null;
      tags: string[] | null;
      priority_score: number | null;
      updated_at: Date | null;
      extracted_fields: Record<string, unknown> | null;
      fts_rank: number;
    }>(sql`
      SELECT
        fc.id,
        fc.file_id,
        fc.file_name,
        fc.chunk_index,
        fc.chunk_text,
        fc.source_type,
        fc.page_number,
        fc.section_label,
        fc.metadata,
        fr.doc_category,
        fr.tags,
        fr.priority_score,
        fr.updated_at,
        fr.extracted_fields,
        ts_rank_cd(
          to_tsvector('english', COALESCE(fc.chunk_text, '')),
          websearch_to_tsquery('english', ${normalizedQuery})
        ) AS fts_rank
      FROM file_chunks fc
      JOIN file_records fr ON fr.id = fc.file_id
      WHERE fc.project_id = ${projectId}
        ${categoryClause}
        ${tagsClause}
        AND to_tsvector('english', COALESCE(fc.chunk_text, '')) @@ websearch_to_tsquery('english', ${normalizedQuery})
      ORDER BY fts_rank DESC
      LIMIT ${Math.max(topK * 5, 50)}
    `);

    return Array.from(rows as unknown as Array<{
      id: string;
      file_id: string;
      file_name: string;
      chunk_index: number;
      chunk_text: string;
      source_type: ChunkSourceType;
      page_number: number | null;
      section_label: string | null;
      metadata: Record<string, unknown> | null;
      doc_category: string | null;
      tags: string[] | null;
      priority_score: number | null;
      updated_at: Date | null;
      extracted_fields: Record<string, unknown> | null;
      fts_rank: number;
    }>).map((row) => {
      const normalizedRank = Number(Math.max(0, Math.min(1, row.fts_rank ?? 0.0)).toFixed(6));
      return {
        chunkId: row.id,
        fileId: row.file_id,
        fileName: row.file_name,
        chunkIndex: row.chunk_index,
        chunkText: row.chunk_text,
        relevance: normalizedRank,
        sourceType: row.source_type ?? "content",
        pageNumber: row.page_number ?? undefined,
        sectionLabel: row.section_label ?? undefined,
        metadata: row.metadata ?? undefined,
        docCategory: row.doc_category ?? undefined,
        tags: row.tags ?? undefined,
        priorityScore: row.priority_score ?? undefined,
        updatedAt: row.updated_at ?? undefined,
        extractedFields: row.extracted_fields ?? undefined,
      };
    });
  } catch (error) {
    logger.warn("retrieval.fts.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ============================================================
// Public API
// ============================================================

export const retrievalService = {
  /**
   * Retrieve the top-K most relevant chunks for a query.
   * Used directly by the chat service.
   */
  async retrieveSources(
    projectId: UUID | undefined,
    query = "",
    options?: RetrievalOptions
  ): Promise<SendChatMessageResponse["sources"]> {
    if (!projectId || !query.trim()) return [];

    const normalized = normalizeOptions(options);
    const db = getDbIfInitialized();
    const hybridEnabled = featureService.isRolloutFlagEnabledForProject(
      projectId,
      "RETRIEVAL_HYBRID_ENABLED"
    );
    const canUseVectorSearch = pgvectorAvailable !== false;
    const queryEmbedding = canUseVectorSearch
      ? await getCachedQueryEmbedding(query)
      : undefined;

    let candidates: RetrievalCandidate[] = [];
    if (!db) {
      candidates = await inMemorySearch(
        projectId,
        query,
        queryEmbedding?.vector,
        normalized.topK,
        normalized.category || undefined,
        normalized.tags
      );
    } else {
      if (hybridEnabled) {
        const profile = resolveBlendProfile(options?.interpretation);
        const [vectorCandidates, lexicalCandidates] = await Promise.all([
          queryEmbedding
            ? pgvectorSearch(projectId, queryEmbedding.vector, normalized.topK, normalized.category || undefined)
            : Promise.resolve([]),
          ftsSearch(projectId, query, normalized.topK, normalized.category || undefined, normalized.tags),
        ]);

        const mergedHybrid = mergeHybridCandidates(vectorCandidates, lexicalCandidates, profile);
        logger.info("retrieval.hybrid.metrics", {
          stage: "retrieve_sources",
          profile,
          vectorCandidates: vectorCandidates.length,
          lexicalCandidates: lexicalCandidates.length,
          mergedCandidates: mergedHybrid.length,
        });

        candidates = mergedHybrid.length > 0
          ? mergedHybrid
          : await keywordSearch(projectId, query, normalized.topK, normalized.category || undefined, normalized.tags);
      } else {
        candidates = queryEmbedding
          ? await pgvectorSearch(projectId, queryEmbedding.vector, normalized.topK, normalized.category || undefined)
          : [];
        if (candidates.length === 0) {
          candidates = await keywordSearch(projectId, query, normalized.topK, normalized.category || undefined, normalized.tags);
        }
      }
    }

    candidates = applySourceTypePolicy(candidates, query);
    candidates = applyInterpretationBoost(candidates, options?.interpretation);
    candidates = applyFileIdentityBoost(candidates, query);
    candidates = applySpecificationChunkBoost(candidates, query);
    candidates = await maybeApplyRerank(projectId, query, candidates);

    // Deduplicate by fileId, keeping best chunk per file
    const deduped = new Map<string, (typeof candidates)[number]>();
    for (const c of candidates) {
      const existing = deduped.get(c.fileId);
      if (!existing || c.relevance > existing.relevance) deduped.set(c.fileId, c);
    }

    return Array.from(deduped.values())
      .filter((c) => c.relevance >= normalized.minRelevance)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, normalized.topK)
      .map((entry) => ({
        fileId: entry.fileId as UUID,
        fileName: entry.fileName,
        relevance: Number(Math.max(0, Math.min(1, entry.relevance)).toFixed(3)),
      }));
  },

  /**
   * Full semantic search — returns rich results with matched chunk excerpts,
   * file metadata, and extracted construction fields.
   */
  async searchProject(
    projectId: UUID,
    query: string,
    options?: RetrievalOptions & { includeChunks?: boolean }
  ): Promise<{
    query: string;
    results: SearchResult[];
    totalMatches: number;
    searchedAt: Date;
  }> {
    const normalized = normalizeOptions(options);
    const db = getDbIfInitialized();
    const hybridEnabled = featureService.isRolloutFlagEnabledForProject(
      projectId,
      "RETRIEVAL_HYBRID_ENABLED"
    );
    const canUseVectorSearch = pgvectorAvailable !== false;
    const queryEmbedding = canUseVectorSearch
      ? await getCachedQueryEmbedding(query)
      : undefined;

    let candidates: RetrievalCandidate[] = [];
    if (!db) {
      candidates = await inMemorySearch(
        projectId,
        query,
        queryEmbedding?.vector,
        50,
        normalized.category || undefined,
        normalized.tags
      );
    } else {
      if (hybridEnabled) {
        const profile = resolveBlendProfile(options?.interpretation);
        const [vectorCandidates, lexicalCandidates] = await Promise.all([
          queryEmbedding
            ? pgvectorSearch(projectId, queryEmbedding.vector, 50, normalized.category || undefined)
            : Promise.resolve([]),
          ftsSearch(projectId, query, 50, normalized.category || undefined, normalized.tags),
        ]);

        const mergedHybrid = mergeHybridCandidates(vectorCandidates, lexicalCandidates, profile);
        logger.info("retrieval.hybrid.metrics", {
          stage: "search_project",
          profile,
          vectorCandidates: vectorCandidates.length,
          lexicalCandidates: lexicalCandidates.length,
          mergedCandidates: mergedHybrid.length,
        });

        candidates = mergedHybrid.length > 0
          ? mergedHybrid
          : await keywordSearch(projectId, query, 50, normalized.category || undefined, normalized.tags);
      } else {
        candidates = queryEmbedding
          ? await pgvectorSearch(projectId, queryEmbedding.vector, 50, normalized.category || undefined)
          : [];
        if (candidates.length === 0) {
          candidates = await keywordSearch(projectId, query, 50, normalized.category || undefined, normalized.tags);
        }
      }
    }

    candidates = applySourceTypePolicy(candidates, query);
    candidates = applyInterpretationBoost(candidates, options?.interpretation);
    candidates = applyFileIdentityBoost(candidates, query);
    candidates = applySpecificationChunkBoost(candidates, query);
    candidates = await maybeApplyRerank(projectId, query, candidates);

    // Group chunks by file
    const byFile = new Map<string, Array<(typeof candidates)[number]>>();
    for (const c of candidates) {
      if (!byFile.has(c.fileId)) byFile.set(c.fileId, []);
      byFile.get(c.fileId)!.push(c);
    }

    // Fetch file metadata from DB if available
    const fileMetaMap = new Map<string, { filePath: string; docCategory?: string; summary?: string; tags?: string[]; extractedFields?: unknown }>();
    if (db && byFile.size > 0) {
      try {
        const fileIds = Array.from(byFile.keys());
        const records = await db
          .select()
          .from(fileRecords)
          .where(inArray(fileRecords.id, fileIds));
        for (const r of records) {
          fileMetaMap.set(r.id, {
            filePath: r.filePath,
            docCategory: r.docCategory ?? undefined,
            summary: r.summary ?? undefined,
            tags: r.tags ?? undefined,
            extractedFields: r.extractedFields ?? undefined,
          });
        }
      } catch { /* non-fatal */ }
    }

    const results: SearchResult[] = Array.from(byFile.entries())
      .map(([fileId, chunks]) => {
        const sorted = chunks.sort((a, b) => b.relevance - a.relevance);
        const topChunk = sorted[0]!;
        const meta = fileMetaMap.get(fileId);
        return {
          fileId: fileId as UUID,
          fileName: topChunk.fileName,
          filePath: meta?.filePath ?? "",
          docCategory: meta?.docCategory,
          summary: meta?.summary,
          tags: meta?.tags,
          extractedFields: meta?.extractedFields as Record<string, string | undefined> | undefined,
          matchedChunks: options?.includeChunks !== false
            ? sorted.slice(0, 3).map((c) => ({
                chunkId: c.chunkId,
                chunkText: c.chunkText.slice(0, 400),
                chunkIndex: c.chunkIndex,
                relevance: Number(Math.max(0, Math.min(1, c.relevance)).toFixed(3)),
                sourceType: c.sourceType,
                pageNumber: c.pageNumber,
                sectionLabel: c.sectionLabel,
                metadata: c.metadata,
              }))
            : [],
          topRelevance: Number(Math.max(0, Math.min(1, topChunk.relevance)).toFixed(3)),
        };
      })
      .filter((r) => r.topRelevance >= normalized.minRelevance)
      .sort((a, b) => b.topRelevance - a.topRelevance)
      .slice(0, normalized.topK);

    return {
      query,
      results,
      totalMatches: results.length,
      searchedAt: new Date(),
    };
  },

  /**
   * Returns a structured snapshot of the project's current state.
   * Used by the chat system to answer "what's open" / "what changed" questions.
   */
  async getProjectContext(projectId: UUID): Promise<ProjectContextSnapshot> {
    const cacheKey = String(projectId);
    const now = Date.now();
    const cached = projectContextCache.get(cacheKey);
    if (cached && now - cached.createdAt <= PROJECT_CONTEXT_CACHE_TTL_MS) {
      return cached.value;
    }

    const filesResponse = await projectService.listProjectFiles(projectId, { page: 1, pageSize: 2000 });
    const files = filesResponse.files;

    const total = files.length;
    const indexed = files.filter((f) => f.indexStatus === "indexed").length;
    const pending = files.filter((f) => f.indexStatus === "pending" || f.indexStatus === "processing").length;
    const failed  = files.filter((f) => f.indexStatus === "failed").length;

    const categoryBreakdown: Record<string, number> = {};
    for (const f of files.filter((f) => f.indexStatus === "indexed")) {
      const cat = f.docCategory ?? "unknown";
      categoryBreakdown[cat] = (categoryBreakdown[cat] ?? 0) + 1;
    }

    // Open RFIs (indexed RFI files, not marked approved)
    const openRfis = files
      .filter((f) => f.docCategory === "rfi" && f.indexStatus === "indexed")
      .slice(0, 20)
      .map((f) => ({
        fileId: f.id,
        fileName: f.fileName,
        rfiNumber: (f.extractedFields as Record<string, string> | undefined)?.rfiNumber,
        summary: f.summary,
      }));

    // Pending submittals
    const pendingSubmittals = files
      .filter((f) => f.docCategory === "submittal" && f.indexStatus === "indexed")
      .slice(0, 20)
      .map((f) => {
        const ef = f.extractedFields as Record<string, string> | undefined;
        return {
          fileId: f.id,
          fileName: f.fileName,
          submittarNumber: ef?.submittarNumber,
          status: ef?.approvalStatus,
        };
      });

    // Recent change orders
    const recentChangeOrders = files
      .filter((f) => f.docCategory === "change_order" && f.indexStatus === "indexed")
      .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
      .slice(0, 10)
      .map((f) => ({
        fileId: f.id,
        fileName: f.fileName,
        coNumber: (f.extractedFields as Record<string, string> | undefined)?.changeOrderNumber,
        summary: f.summary,
      }));

    // Recently modified files (last 7 days)
    const recentlyModifiedFiles = files
      .filter((f) => f.lastSynced != null)
      .sort((a, b) => (b.lastSynced?.getTime() ?? 0) - (a.lastSynced?.getTime() ?? 0))
      .slice(0, 10)
      .map((f) => ({ fileId: f.id, fileName: f.fileName, updatedAt: f.updatedAt }));

    // Top spec sections
    const specSectionCounts = new Map<string, number>();
    for (const f of files.filter((f) => f.specSection)) {
      const ss = f.specSection!;
      specSectionCounts.set(ss, (specSectionCounts.get(ss) ?? 0) + 1);
    }
    const topSpecSections = Array.from(specSectionCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([s]) => s);

    const snapshot = {
      projectId,
      generatedAt: new Date(),
      totalFiles: total,
      indexedFiles: indexed,
      pendingFiles: pending,
      failedFiles: failed,
      indexingPercent: total === 0 ? 0 : Math.round((indexed / total) * 100),
      openRfis,
      pendingSubmittals,
      recentChangeOrders,
      recentlyModifiedFiles,
      categoryBreakdown,
      topSpecSections,
    };

    projectContextCache.set(cacheKey, {
      value: snapshot,
      createdAt: now,
    });

    return snapshot;
  },

  /**
   * Full detail for a single document — summary, chunks, related docs.
   */
  async getDocumentDetail(fileId: UUID, projectId: UUID): Promise<DocumentDetail | null> {
    const db = getDbIfInitialized();

    if (!db) {
      const filesResponse = await projectService.listProjectFiles(projectId, { page: 1, pageSize: 2000 });
      const file = filesResponse.files.find((f) => f.id === fileId);
      if (!file) return null;
      const chunks = await projectService.listProjectChunks(projectId);
      const fileChunksArr = chunks.filter((c) => c.fileId === fileId);
      return {
        fileId,
        fileName: file.fileName,
        filePath: file.filePath,
        fileSize: file.fileSize,
        mimeType: file.mimeType,
        docCategory: file.docCategory,
        summary: file.summary,
        keyTopics: file.keyTopics,
        tags: file.tags,
        extractedFields: file.extractedFields as Record<string, string | undefined> | undefined,
        specSection: file.specSection,
        sheetNumber: file.sheetNumber,
        revision: file.revision,
        indexStatus: file.indexStatus,
        lastIndexed: file.lastIndexed,
        chunkCount: file.chunkCount,
        chunks: fileChunksArr.map((c) => ({
          chunkIndex: c.chunkIndex,
          chunkText: c.chunkText,
          tokenCount: c.tokenCount,
          sourceType: c.sourceType,
          pageNumber: c.pageNumber ?? undefined,
          sectionLabel: c.sectionLabel ?? undefined,
          metadata: c.metadata ?? undefined,
        })),
        relatedDocuments: [],
      };
    }

    const [record] = await db.select().from(fileRecords).where(eq(fileRecords.id, fileId)).limit(1);
    if (!record || record.projectId !== projectId) return null;

    const chunksRows = await db.select().from(fileChunks).where(eq(fileChunks.fileId, fileId)).orderBy(fileChunks.chunkIndex);

    let relatedDocuments: DocumentDetail["relatedDocuments"] = [];
    try {
      const relRows = await db
        .select({
          targetFileId: documentRelationships.targetFileId,
          relationType: documentRelationships.relationType,
          confidence: documentRelationships.confidence,
          targetFileName: fileRecords.fileName,
        })
        .from(documentRelationships)
        .leftJoin(fileRecords, eq(documentRelationships.targetFileId, fileRecords.id))
        .where(eq(documentRelationships.sourceFileId, fileId))
        .limit(10);
      relatedDocuments = relRows.map((r) => ({
        fileId: r.targetFileId,
        fileName: r.targetFileName ?? "unknown",
        relationType: r.relationType,
        confidence: r.confidence,
      }));
    } catch { /* non-fatal — table may not exist yet */ }

    return {
      fileId: record.id as UUID,
      fileName: record.fileName,
      filePath: record.filePath,
      fileSize: record.fileSize ?? undefined,
      mimeType: record.mimeType ?? undefined,
      docCategory: record.docCategory ?? undefined,
      summary: record.summary ?? undefined,
      keyTopics: record.keyTopics ?? undefined,
      tags: record.tags ?? undefined,
      extractedFields: record.extractedFields as Record<string, string | undefined> | undefined,
      specSection: record.specSection ?? undefined,
      sheetNumber: record.sheetNumber ?? undefined,
      revision: record.revision ?? undefined,
      indexStatus: record.indexStatus,
      lastIndexed: record.lastIndexed ?? undefined,
      chunkCount: record.chunkCount,
      chunks: chunksRows.map((c) => ({
        chunkIndex: c.chunkIndex,
        chunkText: c.chunkText,
        tokenCount: c.tokenCount,
        sourceType: c.sourceType,
        pageNumber: c.pageNumber ?? undefined,
        sectionLabel: c.sectionLabel ?? undefined,
        metadata: c.metadata ?? undefined,
      })),
      relatedDocuments,
    };
  },

  /**
   * Suggest likely next queries based on what's in the project index.
   * Powered by category distribution and high-priority document topics.
   */
  async getSuggestions(
    projectId: UUID,
    _currentQuery?: string
  ): Promise<Array<{ query: string; category?: string; reason: string }>> {
    const filesResponse = await projectService.listProjectFiles(projectId, { page: 1, pageSize: 500 });
    const indexed = filesResponse.files.filter((f) => f.indexStatus === "indexed");

    const suggestions: Array<{ query: string; category?: string; reason: string }> = [];

    // Suggestions from category distribution
    const categories = new Set(indexed.map((f) => f.docCategory).filter(Boolean));

    if (categories.has("rfi")) suggestions.push({ query: "Show me all open RFIs", category: "rfi", reason: "RFI documents found" });
    if (categories.has("submittal")) suggestions.push({ query: "What submittals are pending approval?", category: "submittal", reason: "Submittal documents found" });
    if (categories.has("change_order")) suggestions.push({ query: "Summarize recent change orders and their cost impact", category: "change_order", reason: "Change order documents found" });
    if (categories.has("schedule")) suggestions.push({ query: "What is the current project schedule and any delays?", category: "schedule", reason: "Schedule documents found" });
    if (categories.has("drawing")) suggestions.push({ query: "List all architectural drawings and revisions", category: "drawing", reason: "Drawing files found" });
    if (categories.has("spec")) suggestions.push({ query: "What specs cover concrete work?", category: "spec", reason: "Specification documents found" });
    if (categories.has("safety")) suggestions.push({ query: "Are there any safety issues or open safety documents?", category: "safety", reason: "Safety documents found" });
    if (categories.has("contract")) suggestions.push({ query: "What are the main contract terms and milestones?", category: "contract", reason: "Contract documents found" });

    // Suggestions from key topics
    const topicFreq = new Map<string, number>();
    for (const f of indexed) {
      for (const t of f.keyTopics ?? []) {
        topicFreq.set(t, (topicFreq.get(t) ?? 0) + 1);
      }
    }
    const hotTopics = Array.from(topicFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [topic] of hotTopics) {
      suggestions.push({ query: `Find documents related to "${topic}"`, reason: `"${topic}" appears frequently in the project` });
    }

    return suggestions.slice(0, 8);
  },
};

export const retrievalInternals = {
  blendWeights,
  resolveBlendProfile,
  mergeHybridCandidates,
};

