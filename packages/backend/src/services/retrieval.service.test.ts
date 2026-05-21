import type { UUID } from "@contractor/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { embeddingsService } from "./embeddings.service";
import { projectService } from "./project.service";
import { retrievalInternals, retrievalService } from "./retrieval.service";

function asUuid(value: string): UUID {
  return value as UUID;
}

describe("retrievalService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns deduplicated top sources by relevance", async () => {
    vi.spyOn(embeddingsService, "embedText").mockResolvedValue({
      model: "test",
      vector: [1, 0, 0],
    });

    vi.spyOn(projectService, "listProjectChunks").mockResolvedValue([
      {
        id: asUuid("chunk-1"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-a"),
        fileName: "spec-a.pdf",
        chunkIndex: 0,
        chunkText: "spec details",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [0.9, 0.1, 0],
      },
      {
        id: asUuid("chunk-2"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-a"),
        fileName: "spec-a.pdf",
        chunkIndex: 1,
        chunkText: "extra spec details",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [0.4, 0.6, 0],
      },
      {
        id: asUuid("chunk-3"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-b"),
        fileName: "rfi-b.docx",
        chunkIndex: 0,
        chunkText: "rfi details",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [0.8, 0.2, 0],
      },
    ]);

    const sources = await retrievalService.retrieveSources(asUuid("project-1"), "spec question");

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ fileId: asUuid("file-a"), fileName: "spec-a.pdf" });
    expect(sources[1]).toMatchObject({ fileId: asUuid("file-b"), fileName: "rfi-b.docx" });
    expect(sources[0]?.relevance).toBeGreaterThanOrEqual(sources[1]?.relevance ?? 0);
  });

  it("applies category and tag filters", async () => {
    vi.spyOn(embeddingsService, "embedText").mockResolvedValue({
      model: "test",
      vector: [1, 0],
    });

    vi.spyOn(projectService, "listProjectChunks").mockResolvedValue([
      {
        id: asUuid("chunk-1"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-a"),
        fileName: "spec-a.pdf",
        chunkIndex: 0,
        chunkText: "spec details",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [1, 0],
        docCategory: "spec",
        tags: ["Mechanical", "HVAC"],
      },
      {
        id: asUuid("chunk-2"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-b"),
        fileName: "drawing-b.pdf",
        chunkIndex: 0,
        chunkText: "drawing details",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [1, 0],
        docCategory: "drawing",
        tags: ["electrical"],
      },
    ]);

    const sources = await retrievalService.retrieveSources(asUuid("project-1"), "question", {
      category: "spec",
      tags: ["hvac"],
    });

    expect(sources).toEqual([
      {
        fileId: asUuid("file-a"),
        fileName: "spec-a.pdf",
        relevance: 1,
      },
    ]);
  });

  it("enforces topK and minRelevance bounds", async () => {
    vi.spyOn(embeddingsService, "embedText").mockResolvedValue({
      model: "test",
      vector: [1, 0],
    });

    vi.spyOn(projectService, "listProjectChunks").mockResolvedValue([
      {
        id: asUuid("chunk-1"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-a"),
        fileName: "a.pdf",
        chunkIndex: 0,
        chunkText: "a",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [1, 0],
      },
      {
        id: asUuid("chunk-2"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-b"),
        fileName: "b.pdf",
        chunkIndex: 0,
        chunkText: "b",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [0.5, 0.5],
      },
    ]);

    const sources = await retrievalService.retrieveSources(asUuid("project-1"), "question", {
      topK: 1,
      minRelevance: 0.9,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ fileId: asUuid("file-a"), fileName: "a.pdf" });
  });

  it("reuses the same query embedding across repeated retrieval calls", async () => {
    const embedSpy = vi.spyOn(embeddingsService, "embedText").mockResolvedValue({
      model: "test",
      vector: [1, 0],
    });

    vi.spyOn(projectService, "listProjectChunks").mockResolvedValue([
      {
        id: asUuid("chunk-1"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-a"),
        fileName: "a.pdf",
        chunkIndex: 0,
        chunkText: "question",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [1, 0],
      },
    ]);

    await retrievalService.retrieveSources(asUuid("project-1"), "same query");
    await retrievalService.retrieveSources(asUuid("project-1"), "same query");

    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it("boosts candidates matching interpretation hints", async () => {
    vi.spyOn(embeddingsService, "embedText").mockResolvedValue({
      model: "test",
      vector: [1, 0],
    });

    vi.spyOn(projectService, "listProjectChunks").mockResolvedValue([
      {
        id: asUuid("chunk-schedule"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-schedule"),
        fileName: "schedule-log.pdf",
        chunkIndex: 0,
        chunkText: "Critical path delay and milestone impacts.",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [1, 0],
        docCategory: "schedule",
        tags: ["delay", "milestone"],
      },
      {
        id: asUuid("chunk-drawing"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-drawing"),
        fileName: "site-plan.pdf",
        chunkIndex: 0,
        chunkText: "Site grading legend and notes.",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [1, 0],
        docCategory: "drawing",
        tags: ["site"],
      },
    ]);

    const sources = await retrievalService.retrieveSources(asUuid("project-1"), "delay risk", {
      topK: 2,
      interpretation: {
        intent: "schedule_risk",
        confidence: 0.9,
        retrievalHints: {
          preferredCategories: ["schedule"],
          preferredTags: ["delay"],
        },
      },
    });

    expect(sources).toHaveLength(2);
    expect(sources[0]?.fileId).toBe(asUuid("file-schedule"));
  });

  it("downweights ubiquitous lexical tokens during keyword scoring", async () => {
    vi.spyOn(embeddingsService, "embedText").mockResolvedValue({
      model: "test",
      vector: [0, 0],
    });

    vi.spyOn(projectService, "listProjectChunks").mockResolvedValue([
      {
        id: asUuid("chunk-noise-1"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-noise-1"),
        fileName: "Volume_01_PRDC.pdf",
        chunkIndex: 0,
        chunkText: "Volume and PRDC administrative notes.",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [0, 0],
      },
      {
        id: asUuid("chunk-noise-2"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-noise-2"),
        fileName: "General_PRDC_Memo.pdf",
        chunkIndex: 0,
        chunkText: "PRDC and volume references only.",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [0, 0],
      },
      {
        id: asUuid("chunk-hit"),
        projectId: asUuid("project-1"),
        fileId: asUuid("file-hit"),
        fileName: "Volume_05_PRDC.pdf",
        chunkIndex: 0,
        chunkText: "Expansion joint specifications for station structure.",
        sourceType: "content",
        tokenCount: 10,
        embeddingModel: "test",
        embedding: [0, 0],
      },
    ]);

    const sources = await retrievalService.retrieveSources(
      asUuid("project-1"),
      "volume prdc expansion joint specifications",
      { topK: 3 }
    );

    expect(sources).toHaveLength(3);
    expect(sources[0]?.fileId).toBe(asUuid("file-hit"));
    expect(sources[0]?.relevance).toBeGreaterThan(sources[1]?.relevance ?? 0);
  });

  it("merges hybrid candidates with lexical-heavy blend profile", () => {
    const merged = retrievalInternals.mergeHybridCandidates(
      [
        {
          chunkId: "chunk-1",
          fileId: "file-1",
          fileName: "spec.pdf",
          chunkIndex: 0,
          chunkText: "semantic",
          relevance: 0.8,
          sourceType: "content",
        },
      ],
      [
        {
          chunkId: "chunk-1",
          fileId: "file-1",
          fileName: "spec.pdf",
          chunkIndex: 0,
          chunkText: "lexical",
          relevance: 0.4,
          sourceType: "content",
        },
      ],
      "lexical_heavy"
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.relevance).toBeCloseTo(0.54, 3);
  });

  it("selects lexical-heavy blend profile for active_doc_qa intent", () => {
    const profile = retrievalInternals.resolveBlendProfile({
      intent: "active_doc_qa",
      confidence: 0.9,
    });

    expect(profile).toBe("lexical_heavy");
  });
});
