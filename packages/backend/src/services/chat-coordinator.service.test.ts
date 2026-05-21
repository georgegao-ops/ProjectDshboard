import type { UUID } from "@contractor/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../config/env";
import {
  chatCoordinatorService,
  classifyQueryDomains,
} from "./chat-coordinator.service";
import { logger } from "../lib/logger";
import { projectService } from "./project.service";
import { retrievalService } from "./retrieval.service";

function asUuid(value: string): UUID {
  return value as UUID;
}

describe("chatCoordinatorService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CHAT_ACTIVE_DOC_BOOST_ENABLED;
    delete process.env.CHAT_CITATION_FALLBACK_ENABLED;
    delete process.env.CHAT_STRICT_FACTUAL_ACTIVE_DOC_MODE;
    delete process.env.CHAT_SECTION_PROXIMITY_BOOST_ENABLED;
    delete process.env.CHAT_STRICT_CITATION_VERIFICATION_ENABLED;
    delete process.env.CHAT_RETRIEVAL_TRACE_ENABLED;
    resetEnvCache();
  });

  it("classifies construction scheduling and contract-heavy queries", () => {
    const domains = classifyQueryDomains(
      "Draft a delay notice with critical path impact and owner notification requirements"
    );

    expect(domains).toContain("scheduling");
    expect(domains).toContain("contracts");
  });

  it("returns a PM-style greeting for conversational prompts", async () => {
    const searchSpy = vi.spyOn(retrievalService, "searchProject");

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-greeting"),
      "hi"
    );

    expect(result.content.toLowerCase()).toContain("construction pm assistant");
    expect(result.content.toLowerCase()).not.toContain("could not find enough indexed graph context");
    expect(result.coordinator.domains).toContain("communication");
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("returns filename matches for file existence lookup prompts", async () => {
    vi.spyOn(projectService, "listProjectFiles").mockResolvedValue({
      files: [
        {
          id: asUuid("file-demo-1"),
          projectId: asUuid("project-files"),
          onedriveItemId: "onedrive-item-1",
          fileName: "A37806_01 35 10_AVI-107R00 - ORIG - SWP-040-AVI Installation of Demo Shield.pdf",
          filePath: "05 - SUBMITTALS/01 35 10 Construction Safety Requirements/A37806_01 35 10_AVI-107R00 - ORIG - SWP-040-AVI Installation of Demo Shield.pdf",
          fileSize: 30000000,
          mimeType: "application/pdf",
          docCategory: "submittal",
          tags: ["swp"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed",
          chunkCount: 1,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 200,
      hasMore: false,
    });

    const searchSpy = vi.spyOn(retrievalService, "searchProject");

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-files"),
      "is there a demo shield swp"
    );

    expect(result.content.toLowerCase()).toContain("yes, i found");
    expect(result.content.toLowerCase()).toContain("demo shield");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(asUuid("file-demo-1"));
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("returns filename matches for natural-language 'looking for' prompts", async () => {
    vi.spyOn(projectService, "listProjectFiles").mockResolvedValue({
      files: [
        {
          id: asUuid("file-hasp-1"),
          projectId: asUuid("project-files"),
          onedriveItemId: "onedrive-item-hasp-1",
          fileName: "A37806_01 35 10_GEN-008R00 - R&R - HASP.pdf",
          filePath: "05 - SUBMITTALS/01 35 10 Construction Safety Requirements/A37806_01 35 10_GEN-008R00 - R&R - HASP.pdf",
          fileSize: 30000000,
          mimeType: "application/pdf",
          docCategory: "submittal",
          tags: ["hasp", "safety"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed",
          chunkCount: 1,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 200,
      hasMore: false,
    });

    const searchSpy = vi.spyOn(retrievalService, "searchProject");

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-files"),
      "i am looking for the hasp"
    );

    expect(result.content.toLowerCase()).toContain("yes, i found");
    expect(result.content.toLowerCase()).toContain("hasp");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(asUuid("file-hasp-1"));
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("returns filename matches for short filename fragment prompts", async () => {
    vi.spyOn(projectService, "listProjectFiles").mockResolvedValue({
      files: [
        {
          id: asUuid("file-demo-2"),
          projectId: asUuid("project-files"),
          onedriveItemId: "onedrive-item-2",
          fileName: "A37806_01 35 10_AVI-107R00 - ORIG - SWP-040-AVI Installation of Demo Shield.pdf",
          filePath: "05 - SUBMITTALS/01 35 10 Construction Safety Requirements/A37806_01 35 10_AVI-107R00 - ORIG - SWP-040-AVI Installation of Demo Shield.pdf",
          fileSize: 30000000,
          mimeType: "application/pdf",
          docCategory: "submittal",
          tags: ["swp"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed",
          chunkCount: 1,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 200,
      hasMore: false,
    });

    const searchSpy = vi.spyOn(retrievalService, "searchProject");

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-files"),
      "demo shiel"
    );

    expect(result.content.toLowerCase()).toContain("yes, i found");
    expect(result.content.toLowerCase()).toContain("demo shield");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(asUuid("file-demo-2"));
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("matches selected filename words even when query order is different", async () => {
    vi.spyOn(projectService, "listProjectFiles").mockImplementation(async (_projectId, query) => {
      const files = [
        {
          id: asUuid("file-demo-3"),
          projectId: asUuid("project-files"),
          onedriveItemId: "onedrive-item-3",
          fileName: "A37806_01 35 10_GEN-020R01 - ORIG - SWP-005 - Working Under GO Flagging.pdf",
          filePath: "05 - SUBMITTALS/01 35 10 Construction Safety Requirements/A37806_01 35 10_GEN-020R01 - ORIG - SWP-005 - Working Under GO Flagging.pdf",
          fileSize: 30000000,
          mimeType: "application/pdf",
          docCategory: "submittal" as const,
          tags: ["swp", "flagging"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed" as const,
          chunkCount: 1,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const normalizedSearch = query.search?.trim().toLowerCase();
      const filtered = normalizedSearch
        ? files.filter((file) => `${file.fileName} ${file.filePath}`.toLowerCase().includes(normalizedSearch))
        : files;

      return {
        files: filtered,
        total: filtered.length,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 200,
        hasMore: false,
      };
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-files"),
      "is there a flagging swp"
    );

    expect(result.content.toLowerCase()).toContain("yes, i found");
    expect(result.content.toLowerCase()).toContain("working under go flagging");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(asUuid("file-demo-3"));
  });

  it("keeps answers scoped to the selected file when query references active doc by name", async () => {
    const activeFileId = asUuid("file-hasp-active");
    const activeFileName = "A37806_01 35 10_GEN-008R00 - R&R - HASP.pdf";

    const searchSpy = vi.spyOn(retrievalService, "searchProject");
    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - SUBMITTALS/01 35 10 Construction Safety Requirements/A37806_01 35 10_GEN-008R00 - R&R - HASP.pdf",
      fileSize: 30000000,
      mimeType: "application/pdf",
      docCategory: "submittal",
      summary: "Track safety plan and procedures.",
      keyTopics: ["track safety"],
      tags: ["hasp", "safety"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "00",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 2,
      chunks: [
        {
          chunkIndex: 1,
          chunkText: "Mandatory track safety training, lookout procedures, and work zone controls are required.",
          tokenCount: 22,
        },
        {
          chunkIndex: 2,
          chunkText: "All crews must complete HASP orientation before entering the rail corridor.",
          tokenCount: 16,
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-doc"),
      "what are some track safety things in the hasp",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(activeFileId);
    expect(result.suggestions?.some((s) => /across all project files/i.test(s))).toBe(false);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("routes question-style qwp queries to the matching document directly", async () => {
    const qwpFileId = asUuid("file-qwp-1");
    const qwpFileName = "QWP-002 Drilled Grouted Piles.pdf";

    vi.spyOn(projectService, "listProjectFiles").mockResolvedValue({
      files: [
        {
          id: qwpFileId,
          projectId: asUuid("project-qwp"),
          onedriveItemId: "onedrive-qwp-1",
          fileName: qwpFileName,
          filePath: "04 - QA-QC/QWP-002 Drilled Grouted Piles.pdf",
          fileSize: 1200000,
          mimeType: "application/pdf",
          docCategory: "report",
          tags: ["inspection", "pile"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed",
          chunkCount: 2,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 200,
      hasMore: false,
    });

    const searchSpy = vi.spyOn(retrievalService, "searchProject");
    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: qwpFileId,
      fileName: qwpFileName,
      filePath: "04 - QA-QC/QWP-002 Drilled Grouted Piles.pdf",
      fileSize: 1200000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Pile installation quality work plan.",
      keyTopics: ["hold points", "pile installation"],
      tags: ["inspection", "pile"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "02",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 2,
      chunks: [
        {
          chunkIndex: 1,
          chunkText: "Hold point 1: verify pile location and layout before drilling starts.",
          tokenCount: 15,
          pageNumber: 6,
        },
        {
          chunkIndex: 2,
          chunkText: "Hold point 2: inspect reinforcement cage placement before grout pour.",
          tokenCount: 14,
          pageNumber: 8,
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-qwp"),
      "what are some hold points in the piles qwp"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(qwpFileId);
    expect(result.autoOpenFileName).toBe(qwpFileName);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("returns detailed hold-point matches with page references for extraction-style active-doc queries", async () => {
    const activeFileId = asUuid("file-hold-point-detail");
    const activeFileName = "A37806_01 40 10_GEN-020R03 - APP - QWP-002 Drilled Grouted Piles.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "04 - QA-QC/A37806_01 40 10_GEN-020R03 - APP - QWP-002 Drilled Grouted Piles.pdf",
      fileSize: 1400000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Pile installation quality work plan.",
      keyTopics: ["hold points", "pile installation"],
      tags: ["inspection", "pile"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "03",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 4,
      chunks: [
        {
          chunkIndex: 1,
          chunkText: "Hold Points: Refer to Risk Mitigation Table of this QWP for hold points identified with respect to risk.",
          tokenCount: 22,
          pageNumber: 9,
        },
        {
          chunkIndex: 2,
          chunkText: "Hold Point QWP-02 Rev.03 DRILLED AND GROUTED PILES Pages 9 of 15.",
          tokenCount: 14,
          pageNumber: 13,
        },
        {
          chunkIndex: 3,
          chunkText: "Ref. 31 66 33 3.04.G Hold Point Ref. 31 66 33 3.04.A e) Field Inspection work proceeding without pre-testing.",
          tokenCount: 20,
          pageNumber: 14,
        },
        {
          chunkIndex: 4,
          chunkText: "General implementation phase guidance for inspection personnel responsibilities.",
          tokenCount: 12,
          pageNumber: 5,
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-hold-point-detail"),
      "specify the section or page number within the qwp with a detailed list of hold points",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(activeFileId);
    expect(result.content).toContain("## Detailed Matches");
    expect(result.content.toLowerCase()).toContain("hold point");
    expect(result.content).toContain("(p. 9)");
    expect(result.content).toContain("(p. 13)");
    expect(result.content).toContain("(p. 14)");
  });

  it("returns concise fallback when direct document match is found but detail is unavailable", async () => {
    const qwpFileId = asUuid("file-qwp-missing");
    const qwpFileName = "QWP-002 Drilled Grouted Piles.pdf";

    vi.spyOn(projectService, "listProjectFiles").mockResolvedValue({
      files: [
        {
          id: qwpFileId,
          projectId: asUuid("project-qwp"),
          onedriveItemId: "onedrive-qwp-missing",
          fileName: qwpFileName,
          filePath: "04 - QA-QC/QWP-002 Drilled Grouted Piles.pdf",
          fileSize: 1200000,
          mimeType: "application/pdf",
          docCategory: "report",
          tags: ["inspection", "pile"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "pending",
          chunkCount: 0,
          lastIndexed: undefined,
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 200,
      hasMore: false,
    });

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue(null);
    const searchSpy = vi.spyOn(retrievalService, "searchProject");

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-qwp"),
      "what are the hold points in the piles qwp"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(qwpFileId);
    expect(result.content).toContain("## Need Indexed QWP");
    expect(result.content).toContain("do not have indexed text");
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("prefers active open document when query keywords match it", async () => {
    const activeFileId = asUuid("file-active-expansion");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 2,
      chunks: [
        {
          chunkIndex: 1,
          chunkText: "Expansion joint requirements include movement, sealant, and substrate prep.",
          tokenCount: 14,
          pageNumber: 15,
        },
      ],
      relatedDocuments: [],
    });

    const searchSpy = vi.spyOn(retrievalService, "searchProject");

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-doc-match"),
      "what are the expansion joint requirements",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(activeFileId);
    expect(result.autoOpenFileName).toBe(activeFileName);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("prefers volume-specific document match for direct factual queries", async () => {
    const volume1Id = asUuid("file-volume-1");
    const volume5Id = asUuid("file-volume-5");
    const volume5Name = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(projectService, "listProjectFiles").mockResolvedValue({
      files: [
        {
          id: volume1Id,
          projectId: asUuid("project-volume"),
          onedriveItemId: "onedrive-volume-1",
          fileName: "A37806_Volume_01_Instructions_to_Proposers.pdf",
          filePath: "01 - RFP/A37806_Volume_01_Instructions_to_Proposers.pdf",
          fileSize: 2000000,
          mimeType: "application/pdf",
          docCategory: "report",
          tags: ["volume"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed",
          chunkCount: 2,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: volume5Id,
          projectId: asUuid("project-volume"),
          onedriveItemId: "onedrive-volume-5",
          fileName: volume5Name,
          filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
          fileSize: 2500000,
          mimeType: "application/pdf",
          docCategory: "report",
          tags: ["volume", "conformed"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed",
          chunkCount: 2,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 2,
      page: 1,
      pageSize: 200,
      hasMore: false,
    });

    vi.spyOn(retrievalService, "getDocumentDetail").mockImplementation(async (fileId) => {
      if (fileId !== volume5Id) {
        return null;
      }

      return {
        fileId: volume5Id,
        fileName: volume5Name,
        filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
        fileSize: 2500000,
        mimeType: "application/pdf",
        docCategory: "report",
        summary: "Expansion joint requirements.",
        keyTopics: ["expansion joints"],
        tags: ["conformed", "prdc"],
        extractedFields: undefined,
        specSection: undefined,
        sheetNumber: undefined,
        revision: "05",
        indexStatus: "indexed",
        lastIndexed: new Date(),
        chunkCount: 1,
        chunks: [
          {
            chunkIndex: 1,
            chunkText: "Expansion joint requirements include sealant and movement criteria.",
            tokenCount: 12,
            pageNumber: 15,
          },
        ],
        relatedDocuments: [],
      };
    });

    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: volume5Id,
          fileName: volume5Name,
          filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
          docCategory: "report",
          tags: ["volume", "conformed"],
          matchedChunks: [
            {
              chunkId: "chunk-volume5",
              chunkIndex: 1,
              chunkText: "Expansion joint requirements include sealant and movement criteria.",
              relevance: 0.93,
              sourceType: "content",
              pageNumber: 15,
            },
          ],
          topRelevance: 0.93,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-volume"),
      "what are expansion joint specs in volume 5 conformed"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(volume5Id);
    expect(result.autoOpenFileName).toBe(volume5Name);
  });

  it("keeps imperative section-review volume queries pinned to the PRDC volume file", async () => {
    const appFileId = asUuid("file-app-1");
    const volume5Id = asUuid("file-volume-5-review");
    const volume5Name = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(projectService, "listProjectFiles").mockResolvedValue({
      files: [
        {
          id: appFileId,
          projectId: asUuid("project-volume-review"),
          onedriveItemId: "onedrive-app-1",
          fileName: "A37806_01 40 10_GEN-018R01 - APP - Submittal Procedures.pdf",
          filePath: "05 - SUBMITTALS/A37806_01 40 10_GEN-018R01 - APP - Submittal Procedures.pdf",
          fileSize: 1700000,
          mimeType: "application/pdf",
          docCategory: "submittal",
          tags: ["app", "procedures"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed",
          chunkCount: 2,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: volume5Id,
          projectId: asUuid("project-volume-review"),
          onedriveItemId: "onedrive-volume-5-review",
          fileName: volume5Name,
          filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
          fileSize: 2500000,
          mimeType: "application/pdf",
          docCategory: "report",
          tags: ["volume", "prdc", "conformed"],
          extractedFields: undefined,
          summary: undefined,
          keyTopics: undefined,
          specSection: undefined,
          sheetNumber: undefined,
          revision: undefined,
          indexStatus: "indexed",
          chunkCount: 4,
          lastIndexed: new Date(),
          lastSynced: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 2,
      page: 1,
      pageSize: 200,
      hasMore: false,
    });

    vi.spyOn(retrievalService, "getDocumentDetail").mockImplementation(async (fileId) => {
      if (fileId !== volume5Id) {
        return null;
      }

      return {
        fileId: volume5Id,
        fileName: volume5Name,
        filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
        fileSize: 2500000,
        mimeType: "application/pdf",
        docCategory: "report",
        summary: "Expansion joint requirements.",
        keyTopics: ["expansion joints"],
        tags: ["conformed", "prdc"],
        extractedFields: undefined,
        specSection: undefined,
        sheetNumber: undefined,
        revision: "05",
        indexStatus: "indexed",
        lastIndexed: new Date(),
        chunkCount: 3,
        chunks: [
          {
            chunkIndex: 617,
            chunkText: "3.52. EXPANSION JOINT ASSEMBLIES 3.52.1. Submittals Build mockup of typical expansion joint assembly.",
            tokenCount: 23,
            pageNumber: 251,
            sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
          },
          {
            chunkIndex: 618,
            chunkText: "Warranty on Painted Finishes: manufacturer agrees to repair finish or replace roof expansion joints.",
            tokenCount: 16,
            pageNumber: 251,
            sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
          },
          {
            chunkIndex: 619,
            chunkText: "3.52.4. Manufactured Roof Expansion Joint (NOT USED)",
            tokenCount: 10,
            pageNumber: 252,
            sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
          },
        ],
        relatedDocuments: [],
      };
    });

    const searchSpy = vi.spyOn(retrievalService, "searchProject");

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-volume-review"),
      "Open and review full text of section 3.52 Expansion Joint in Volume 5 PRDC for complete specifications"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(volume5Id);
    expect(result.autoOpenFileName).toBe(volume5Name);
    expect(result.content).toContain("## Section 3.52 Requirements Summary");
    expect(result.content).toContain("Key requirements captured from the section");
    expect(result.content.toLowerCase()).toContain("expansion joint");
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("routes retrieval and narrows graph context to relevant source files", async () => {
    vi.spyOn(retrievalService, "searchProject")
      .mockResolvedValueOnce({
        query: "",
        totalMatches: 1,
        searchedAt: new Date(),
        results: [
          {
            fileId: asUuid("file-rfi"),
            fileName: "rfi-log.pdf",
            filePath: "",
            docCategory: "rfi",
            tags: ["rfi", "owner_notice"],
            matchedChunks: [
              {
                chunkId: "chunk-1",
                chunkIndex: 0,
                chunkText:
                  "RFI 22 asks for steel embed clarification at grid B4. Response due date is May 5.",
                relevance: 0.93,
                sourceType: "content",
              },
            ],
            topRelevance: 0.93,
          },
        ],
      })
      .mockResolvedValue({ query: "", totalMatches: 0, searchedAt: new Date(), results: [] });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-1"),
      "How should I structure this RFI response and notice?"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.fileId).toBe(asUuid("file-rfi"));
    expect(result.content).toContain("rfi-log");
    expect(result.content).not.toContain("rfi-log.pdf");
    expect(result.content).not.toContain("daily-photo.jpg");
    expect(result.coordinator.domains).toContain("documents");
    expect(result.coordinator.specialistAgents.length).toBeGreaterThan(0);
    expect(result.coordinator.telemetry.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("flags delay risk when schedule evidence exists without cost exposure evidence", async () => {
    vi.spyOn(retrievalService, "searchProject").mockImplementation(async (_projectId, _query, options) => {
      if (options?.tags?.includes("schedule") || options?.category === "report") {
        return {
          query: "",
          totalMatches: 1,
          searchedAt: new Date(),
          results: [
            {
              fileId: asUuid("file-schedule"),
              fileName: "schedule-report.pdf",
              filePath: "",
              docCategory: "report",
              tags: ["schedule", "delay"],
              matchedChunks: [
                {
                  chunkId: "chunk-delay",
                  chunkIndex: 0,
                  chunkText:
                    "Critical path delay shows eight-day slippage due to steel delivery and inspection hold point.",
                  relevance: 0.94,
                  sourceType: "content",
                },
              ],
              topRelevance: 0.94,
            },
          ],
        };
      }

      return { query: "", totalMatches: 0, searchedAt: new Date(), results: [] };
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-contradiction"),
      "Draft owner notice for critical path delay and notice requirements"
    );

    expect(result.coordinator.contradictions.some((signal) => signal.kind === "schedule_delay_without_cost_exposure")).toBe(true);
  });

  it("uses short submittal aliases and parenthesized pages in responses", async () => {
    const longFileName = "A37806_01 35 10_AVI-107R00 - ORIG - SWP-P16 Elevator Steel and Enclosure (Day).pdf";

    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-submittal"),
          fileName: longFileName,
          filePath: "",
          docCategory: "submittal",
          tags: ["swp"],
          extractedFields: { submittarNumber: "SWP P16" },
          matchedChunks: [
            {
              chunkId: "chunk-sub-1",
              chunkIndex: 3,
              chunkText: "Daily enclosure checklist confirms boring protection and steel enclosure sequencing.",
              relevance: 0.95,
              sourceType: "content",
              pageNumber: 12,
            },
          ],
          topRelevance: 0.95,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-submittal"),
      "What does the boring swp require for enclosure sequence?"
    );

    expect(result.content.toLowerCase()).toContain("swp p16");
    expect(result.content.toLowerCase()).toContain("(p. 12)");
    expect(result.content).not.toContain(longFileName);
    expect(result.sources[0]?.displayName?.toLowerCase()).toContain("swp p16");
  });

  it("does not append crowded evidence footer for multi-source factual answers", async () => {
    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 2,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-hold-a"),
          fileName: "QWP-002 Drilled Grouted Piles.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["inspection"],
          matchedChunks: [
            {
              chunkId: "chunk-hold-a",
              chunkIndex: 1,
              chunkText: "Hold point 1 and hold point 2 listed for pile installation.",
              relevance: 0.92,
              sourceType: "content",
              pageNumber: 6,
            },
          ],
          topRelevance: 0.92,
        },
        {
          fileId: asUuid("file-hold-b"),
          fileName: "A37806_01 32 10_GEN-001R02 - AEAN.pdf",
          filePath: "",
          docCategory: "spec",
          tags: ["pile"],
          matchedChunks: [
            {
              chunkId: "chunk-hold-b",
              chunkIndex: 2,
              chunkText: "Additional hold point language for reinforcing cage inspection.",
              relevance: 0.84,
              sourceType: "content",
              pageNumber: 8,
            },
          ],
          topRelevance: 0.84,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-evidence"),
      "what are the hold points for piles"
    );

    expect(result.sources.length).toBeGreaterThan(1);
    expect(result.content).not.toContain("\n\nEvidence:");
  });

  it("strips unrelated leading PRDC boilerplate from factual answer bodies", async () => {
    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-prdc"),
          fileName: "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
          filePath: "",
          docCategory: "spec",
          tags: ["prdc", "spec"],
          matchedChunks: [
            {
              chunkId: "chunk-prdc",
              chunkIndex: 617,
              chunkText: [
                "PRDC 03 - Architecture",
                "Version 0 - 11/18/22 A37806 PRDC 03 - 110",
                "Rev. 2",
                "MTA C&D Contract Number.",
                "3.48. EIFS STUCCO (NOT USED)",
                "3.49. BUILT-UP ROOFING (NOT USED)",
                "3.50. MODIFIED BITUMEN ROOFING (NOT USED)",
                "3.51. SPRAY-ON ROOFING (NOT USED)",
                "3.52. EXPANSION JOINT ASSEMBLIES",
                "3.52.1. Submittals",
                "Build mockups to demonstrate aesthetic effects and to set quality standards.",
              ].join("\n"),
              relevance: 0.97,
              sourceType: "content",
              pageNumber: 251,
            },
          ],
          topRelevance: 0.97,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-prdc"),
      "what are expansion joint specifications"
    );

    expect(result.content).not.toContain("PRDC 03 - Architecture");
    expect(result.content).not.toContain("3.48. EIFS STUCCO (NOT USED)");
    expect(result.content.toLowerCase()).toContain("expansion joint");
  });

  it("returns cached responses for repeated normalized queries", async () => {
    const retrievalSpy = vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-report"),
          fileName: "monthly-report.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["schedule"],
          matchedChunks: [
            {
              chunkId: "chunk-3",
              chunkIndex: 0,
              chunkText: "Baseline vs current schedule shows five-day slippage in envelope activities.",
              relevance: 0.88,
              sourceType: "content",
            },
          ],
          topRelevance: 0.88,
        },
      ],
    });

    const first = await chatCoordinatorService.generateReply(
      asUuid("project-2"),
      "Schedule slippage summary"
    );
    const callsAfterFirst = retrievalSpy.mock.calls.length;

    const second = await chatCoordinatorService.generateReply(
      asUuid("project-2"),
      "  schedule slippage summary  "
    );

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(retrievalSpy.mock.calls.length).toBe(callsAfterFirst);
    expect(second.content).toBe(first.content);
  });

  it("returns route preview metadata for debugging", async () => {
    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-spec"),
          fileName: "division-03-concrete.pdf",
          filePath: "",
          docCategory: "spec",
          tags: ["inspection"],
          matchedChunks: [
            {
              chunkId: "chunk-10",
              chunkIndex: 2,
              chunkText: "Spec section covers concrete curing requirements and testing sequence.",
              relevance: 0.9,
              sourceType: "content",
            },
          ],
          topRelevance: 0.9,
        },
      ],
    });

    const preview = await chatCoordinatorService.previewRoute(
      asUuid("project-3"),
      "What concrete inspection sequence is required?"
    );

    expect(preview.domains.length).toBeGreaterThan(0);
    expect(preview.sources).toHaveLength(1);
    expect(preview.selectedNodes).toHaveLength(1);
    expect(preview.selectedNodes[0]?.fileName).toBe("division-03-concrete.pdf");
    expect(preview.estimatedContextTokens).toBeGreaterThan(0);
  });

  it("keeps only exact source pages when chunks without page metadata are present", async () => {
    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-mixed-pages"),
          fileName: "mixed-pages.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["schedule"],
          matchedChunks: [
            {
              chunkId: "chunk-exact",
              chunkIndex: 2,
              chunkText: "Exact page evidence.",
              relevance: 0.91,
              sourceType: "content",
              pageNumber: 12,
            },
            {
              chunkId: "chunk-fallback",
              chunkIndex: 5,
              chunkText: "Fallback evidence where page number is missing.",
              relevance: 0.77,
              sourceType: "content",
            },
          ],
          topRelevance: 0.91,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-mixed-pages"),
      "what schedule evidence supports this?"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.suggestedPages).toEqual([12]);
    expect(result.sources[0]?.bestPage).toBe(12);
    expect(result.sources[0]?.pageOrigin).toBe("exact");
    expect((result.citations ?? []).every((citation) => typeof citation.pageNumber === "number")).toBe(true);
  });

  it("does not use summary chunks for fallback page numbers", async () => {
    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-summary-only"),
          fileName: "summary-only.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["summary"],
          matchedChunks: [
            {
              chunkId: "chunk-summary",
              chunkIndex: 3,
              chunkText: "Summary chunk with no page number.",
              relevance: 0.8,
              sourceType: "summary",
            },
          ],
          topRelevance: 0.8,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-summary-only"),
      "give me the summary"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.suggestedPages).toBeUndefined();
    expect(result.sources[0]?.bestPage).toBeUndefined();
    expect(result.sources[0]?.pageOrigin).toBeUndefined();
  });

  it("does not inject page 1 for cover-page questions without page metadata", async () => {
    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-cover-no-page"),
          fileName: "cover-without-page-metadata.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["cover"],
          matchedChunks: [
            {
              chunkId: "chunk-cover-no-page",
              chunkIndex: 2,
              chunkText: "Cover/title block text but no stored page metadata.",
              relevance: 0.88,
              sourceType: "content",
            },
          ],
          topRelevance: 0.88,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-cover-no-page"),
      "what is on the cover page"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.suggestedPages).toBeUndefined();
    expect(result.sources[0]?.bestPage).toBeUndefined();
    expect(result.sources[0]?.pageOrigin).toBeUndefined();
  });

  it("uses chunk metadata sourcePageNumbers as fallback page evidence", async () => {
    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-fallback-metadata-pages"),
          fileName: "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["volume", "conformed"],
          matchedChunks: [
            {
              chunkId: "chunk-meta-pages",
              chunkIndex: 17,
              chunkText: "Expansion joint criteria includes joint movement and sealant properties.",
              relevance: 0.89,
              sourceType: "content",
              metadata: {
                sourcePageNumbers: [27, 31],
                sourcePageRange: { start: 27, end: 31 },
              },
            },
          ],
          topRelevance: 0.89,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-meta-fallback-pages"),
      "where are the expansion joint requirements"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.pageOrigin).toBe("fallback");
    expect(result.sources[0]?.suggestedPages).toEqual([27, 31]);
    expect(result.sources[0]?.bestPage).toBe(27);
    expect((result.citations ?? []).some((citation) => citation.pageNumber === 27)).toBe(true);
  });

  it("disables active-document keyword boost when feature flag is off", async () => {
    process.env.CHAT_ACTIVE_DOC_BOOST_ENABLED = "false";
    resetEnvCache();

    const activeFileId = asUuid("file-active-disabled");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    const getDetailSpy = vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 1,
      chunks: [
        {
          chunkIndex: 1,
          chunkText: "Expansion joint requirements include movement, sealant, and substrate prep.",
          tokenCount: 14,
          pageNumber: 15,
        },
      ],
      relatedDocuments: [],
    });

    const searchSpy = vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-other"),
          fileName: "unrelated-report.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["report"],
          matchedChunks: [
            {
              chunkId: "chunk-other",
              chunkIndex: 1,
              chunkText: "General reporting language unrelated to expansion joints.",
              relevance: 0.75,
              sourceType: "content",
              pageNumber: 3,
            },
          ],
          topRelevance: 0.75,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-disabled"),
      "what are the expansion joint requirements",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(searchSpy).toHaveBeenCalled();
    expect(getDetailSpy).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(0);
    expect(result.content.toLowerCase()).toContain("could not find enough indexed graph context");
  });

  it("disables metadata-based page fallback when citation fallback flag is off", async () => {
    process.env.CHAT_CITATION_FALLBACK_ENABLED = "false";
    resetEnvCache();

    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-fallback-disabled"),
          fileName: "fallback-disabled.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["volume"],
          matchedChunks: [
            {
              chunkId: "chunk-meta-disabled",
              chunkIndex: 5,
              chunkText: "Expansion joint criteria includes movement and sealant properties.",
              relevance: 0.9,
              sourceType: "content",
              metadata: {
                sourcePageNumbers: [27, 31],
                sourcePageRange: { start: 27, end: 31 },
              },
            },
          ],
          topRelevance: 0.9,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-fallback-disabled"),
      "where are the expansion joint requirements"
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.pageOrigin).toBeUndefined();
    expect(result.sources[0]?.suggestedPages).toBeUndefined();
    expect((result.citations ?? []).every((citation) => citation.pageNumber === undefined)).toBe(true);
  });

  it("applies strict citation verification in routed factual responses", async () => {
    process.env.CHAT_STRICT_CITATION_VERIFICATION_ENABLED = "true";
    resetEnvCache();

    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-routed-strict"),
          fileName: "routed-strict.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["report"],
          matchedChunks: [
            {
              chunkId: "chunk-routed-generic",
              chunkIndex: 4,
              chunkText: "General project administration language with no technical section detail.",
              relevance: 0.9,
              sourceType: "content",
              pageNumber: 10,
            },
          ],
          topRelevance: 0.9,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-routed-strict"),
      "what are the expansion joint requirements"
    );

    expect(result.citations ?? []).toHaveLength(0);
    expect(result.content.toLowerCase()).toContain("could not validate direct chunk-level evidence");
  });

  it("keeps strict factual mode scoped to active-doc flows only", async () => {
    process.env.CHAT_STRICT_FACTUAL_ACTIVE_DOC_MODE = "true";
    process.env.CHAT_STRICT_CITATION_VERIFICATION_ENABLED = "true";
    resetEnvCache();

    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-routed-strict-scope"),
          fileName: "routed-strict-scope.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["report"],
          matchedChunks: [
            {
              chunkId: "chunk-routed-strict-scope",
              chunkIndex: 1,
              chunkText: "General project language with no expansion joint specifics.",
              relevance: 0.8,
              sourceType: "content",
              pageNumber: 9,
            },
          ],
          topRelevance: 0.8,
        },
      ],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-routed-strict-scope"),
      "what are the expansion joint requirements"
    );

    expect(result.citations ?? []).toHaveLength(0);
    expect(result.content.toLowerCase()).toContain("could not validate direct chunk-level evidence");
    expect(result.content.toLowerCase()).not.toContain("could not find an exact indexed passage");
  });

  it("returns no-exact-evidence guidance for factual active-doc questions with zero keyword hits", async () => {
    const activeFileId = asUuid("file-active-no-hit");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["general requirements"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 2,
      chunks: [
        {
          chunkIndex: 1,
          chunkText: "General conditions and administrative procedures.",
          tokenCount: 8,
          pageNumber: 2,
        },
        {
          chunkIndex: 2,
          chunkText: "Submittal and transmittal process overview.",
          tokenCount: 7,
          pageNumber: 4,
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-no-hit"),
      "what does this conformed document say about expansion joint specifications",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.content.toLowerCase()).toContain("could not find an exact indexed passage");
    expect(result.citations ?? []).toHaveLength(0);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.suggestedPages).toBeUndefined();
  });

  it("suppresses speculative factual output when only generic active-doc tokens match", async () => {
    process.env.CHAT_STRICT_FACTUAL_ACTIVE_DOC_MODE = "true";
    resetEnvCache();

    const activeFileId = asUuid("file-active-generic-only");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["general requirements"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 2,
      chunks: [
        {
          chunkIndex: 1,
          chunkText: "PRDC requirement language for general project controls and conformed document references.",
          tokenCount: 14,
          pageNumber: 2,
        },
        {
          chunkIndex: 2,
          chunkText: "General criteria and project administration requirements with PRDC references.",
          tokenCount: 13,
          pageNumber: 6,
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-generic-only"),
      "based off the volume 5 conformed prdc, what are the expansion joint specifications",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.content.toLowerCase()).toContain("could not find an exact indexed passage");
    expect(result.content.toLowerCase()).not.toContain("likely");
    expect(result.citations ?? []).toHaveLength(0);
  });

  it("emits retrieval trace telemetry when debug flag is enabled", async () => {
    process.env.CHAT_RETRIEVAL_TRACE_ENABLED = "true";
    resetEnvCache();

    const infoSpy = vi.spyOn(logger, "info");
    const activeFileId = asUuid("file-active-trace");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 1,
      chunks: [
        {
          chunkIndex: 1,
          chunkText: "1.3.10 Expansion Joints: Provide stainless-steel heavy-duty expansion joint cover plate.",
          tokenCount: 12,
          pageNumber: 15,
        },
      ],
      relatedDocuments: [],
    });

    await chatCoordinatorService.generateReply(
      asUuid("project-active-trace"),
      "what are the expansion joint requirements",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    const traceCall = infoSpy.mock.calls.find((call) => call[0] === "chat.coordinator.active_doc_trace");
    expect(traceCall).toBeDefined();
  });

  it("keeps boundary-spanning expansion joint queries anchored to section 3.52", async () => {
    const activeFileId = asUuid("file-active-expansion-boundary");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 5,
      chunks: [
        {
          chunkIndex: 617,
          chunkText:
            "3.48. EIFS STUCCO (NOT USED) 3.49. BUILT-UP ROOFING (NOT USED) 3.50. MODIFIED BITUMEN ROOFING (NOT USED) 3.51. SPRAY-ON ROOFING (NOT USED) 3.52. EXPANSION JOINT ASSEMBLIES 3.52.1. Submittals Build mockup of typical expansion joint assembly.",
          tokenCount: 55,
          pageNumber: 251,
        },
        {
          chunkIndex: 618,
          chunkText:
            "Warranty on Painted Finishes: manufacturer agrees to repair finish or replace roof expansion joints that show evidence of deterioration.",
          tokenCount: 24,
          pageNumber: 251,
        },
        {
          chunkIndex: 619,
          chunkText:
            "3.52.4. Manufactured Roof Expansion Joint (NOT USED) 3.52.5. Interior & Exterior Floor, Wall, & Ceiling Expansion Joint Covers Metal-Plate Joint Cover.",
          tokenCount: 31,
          pageNumber: 252,
        },
        {
          chunkIndex: 620,
          chunkText:
            "Elastomeric-Seal Joint Cover and dual-elastomeric-seal joint cover. 3.52.6. Aluminum Finishes.",
          tokenCount: 20,
          pageNumber: 252,
        },
        {
          chunkIndex: 626,
          chunkText:
            "3.54. SHEET METAL FLASHING 3.54.1. Samples. Trim, Metal Closures, Expansion Joints, Joint Intersections, and Miscellaneous Fabrications: 12 inches long.",
          tokenCount: 28,
          pageNumber: 255,
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-expansion-boundary"),
      "based off the volume 5 conformed prdc, what are the expansion joint specifications",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.sources).toHaveLength(1);
    expect(result.content).toContain("Requirements Summary");
    expect(result.content.toLowerCase()).toContain("expansion joint");
    expect(result.sources[0]?.suggestedPages?.some((page) => [251, 252].includes(page))).toBe(true);
    expect(result.sources[0]?.suggestedPages).not.toContain(255);
    expect((result.citations ?? []).every((citation) => [251, 252].includes(citation.pageNumber ?? -1))).toBe(true);
  });

  it("prefers clustered section 3.52 evidence over earlier competing anchors for expansion-joint specs", async () => {
    const activeFileId = asUuid("file-active-expansion-competing-anchors");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 8,
      chunks: [
        {
          chunkIndex: 557,
          chunkText:
            "3.35. JOINT SEALANTS 3.35.1. General specifications for sealant assemblies near expansion locations.",
          tokenCount: 18,
          pageNumber: 223,
          sectionLabel: "3.35. JOINT SEALANTS",
        },
        {
          chunkIndex: 565,
          chunkText:
            "3.35.9. Sealant specifications and movement capability language for sealant joints.",
          tokenCount: 14,
          pageNumber: 227,
          sectionLabel: "3.35. JOINT SEALANTS",
        },
        {
          chunkIndex: 617,
          chunkText:
            "3.52. EXPANSION JOINT ASSEMBLIES 3.52.1. Submittals Build mockup of typical expansion joint assembly.",
          tokenCount: 23,
          pageNumber: 251,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 618,
          chunkText:
            "Warranty on Painted Finishes: manufacturer agrees to repair finish or replace roof expansion joints.",
          tokenCount: 16,
          pageNumber: 251,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 619,
          chunkText:
            "3.52.4. Manufactured Roof Expansion Joint (NOT USED) 3.52.5. Interior and exterior floor, wall, and ceiling expansion joint covers.",
          tokenCount: 23,
          pageNumber: 252,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 620,
          chunkText:
            "Elastomeric-Seal Joint Cover and dual-elastomeric-seal joint cover. 3.52.6. Aluminum Finishes.",
          tokenCount: 20,
          pageNumber: 252,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 626,
          chunkText:
            "3.54. SHEET METAL FLASHING 3.54.1. Samples. Trim, Metal Closures, Expansion Joints, Joint Intersections, and Miscellaneous Fabrications.",
          tokenCount: 20,
          pageNumber: 255,
          sectionLabel: "3.54. SHEET METAL FLASHING",
        },
        {
          chunkIndex: 627,
          chunkText: "General flashing transition details.",
          tokenCount: 5,
          pageNumber: 255,
          sectionLabel: "3.54. SHEET METAL FLASHING",
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-expansion-competing-anchors"),
      "based off the volume 5 conformed prdc, what are the expansion joint specifications",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.sources).toHaveLength(1);
    expect(result.content).toContain("Requirements Summary");
    expect(result.content.toLowerCase()).toContain("expansion joint");
    expect(result.sources[0]?.suggestedPages?.some((page) => [251, 252].includes(page))).toBe(true);
    expect(result.sources[0]?.suggestedPages).not.toContain(223);
    expect(result.sources[0]?.suggestedPages).not.toContain(227);
    expect((result.citations ?? []).every((citation) => [251, 252].includes(citation.pageNumber ?? -1))).toBe(true);
  });

  it("returns section requirements summary for paraphrased volume-5 expansion-joint requirement questions", async () => {
    const activeFileId = asUuid("file-active-expansion-paraphrase");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 4,
      chunks: [
        {
          chunkIndex: 617,
          chunkText:
            "3.52. EXPANSION JOINT ASSEMBLIES 3.52.1. Submittals Build mockups to demonstrate aesthetic effects and to set quality standards for materials and execution. Build mockup of typical expansion joint assembly.",
          tokenCount: 23,
          pageNumber: 250,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 618,
          chunkText:
            "Approval of mockups does not constitute approval of deviations from the Contract Documents contained in mockups unless Project CEO specifically approves such deviations in writing. Subject to compliance with requirements, approved mockups may become part of the completed work if undisturbed at time of Substantial Completion. For publicly visible areas, submit three (3) samples for each expansion joint cover assembly and for each color and texture specified, full width by 6 inches long in size.",
          tokenCount: 16,
          pageNumber: 251,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 619,
          chunkText:
            "3.52.2. Warranty Warranty: Manufacturer and installer agree to repair or replace roof expansion joints and components that leak, deteriorate beyond normal weathering, or otherwise fail in materials or execution within specified warranty period. Warranty Period: Two (2) years from date of Substantial Completion.",
          tokenCount: 28,
          pageNumber: 251,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 620,
          chunkText:
            "Warranty on Painted Finishes: Manufacturer's standard form in which manufacturer agrees to repair finish or replace roof expansion joints that show evidence of deterioration of factory-applied finishes within specified warranty period. Warranty Period: 20 years from date of Substantial Completion.",
          tokenCount: 22,
          pageNumber: 252,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-expansion-paraphrase"),
      "what are the requirements for expansion joints in volume 5 conformed prdc",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.content).toContain("## Section 3.52 Requirements Summary");
    expect(result.content).toContain("### 3.52.1. Submittals");
    expect(result.content).toContain("### 3.52.2. Warranty");
    expect(result.content.toLowerCase()).toContain("submittal");
    expect(result.content.toLowerCase()).toContain("warranty");
    expect(result.content).toContain("Build mockup of typical expansion joint assembly.");
    expect(result.content).toContain("Warranty Period: Two (2) years from date of Substantial Completion.");
    expect(result.content).not.toMatch(/\n-\s*(?:[\u2022\u2023\u2043\u2219\u25E6\u2027\u00B7\uF0B7]+)?\s*(?=\n|$)/);
    expect(result.content.toLowerCase()).not.toContain("could not find an exact indexed passage");
    expect((result.citations ?? []).length).toBeGreaterThan(0);
    expect((result.citations ?? []).every((citation) => [250, 251, 252].includes(citation.pageNumber ?? -1))).toBe(true);
  });

  it("returns detailed subsection summaries for aluminum window specification questions", async () => {
    const activeFileId = asUuid("file-active-aluminum-windows-specs");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["aluminum windows"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 5,
      chunks: [
        {
          chunkIndex: 626,
          chunkText:
            "3.53. ALUMINUM WINDOWS 3.53.1. Performance Requirements. Provide thermally broken aluminum window framing and glazing as indicated.",
          tokenCount: 19,
          pageNumber: 255,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 627,
          chunkText:
            "Air infiltration, water penetration, and structural performance must comply with specified testing standards for aluminum windows.",
          tokenCount: 18,
          pageNumber: 255,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 628,
          chunkText:
            "3.53.2. Quality Assurance. Installer must have documented experience with aluminum window systems of similar scope and complexity.",
          tokenCount: 18,
          pageNumber: 256,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 629,
          chunkText:
            "Field measurements must be verified before fabrication, and window hardware and finish requirements must match approved submittals.",
          tokenCount: 18,
          pageNumber: 256,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 632,
          chunkText: "3.54. SHEET METAL FLASHING.",
          tokenCount: 4,
          pageNumber: 258,
          sectionLabel: "3.54. SHEET METAL FLASHING",
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-aluminum-windows-specs"),
      "based off the volume 5 conformed prdc, what are aluminum window specifications",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.content).toContain("## Section 3.53 Requirements Summary");
    expect(result.content).toContain("### 3.53.1. Performance Requirements");
    expect(result.content).toContain("### 3.53.2. Quality Assurance");
    expect(result.content).toContain("Provide thermally broken aluminum window framing and glazing as indicated.");
    expect(result.content).toContain("Installer must have documented experience with aluminum window systems of similar scope and complexity.");
    expect(result.content).not.toMatch(/\n-\s*(?:[\u2022\u2023\u2043\u2219\u25E6\u2027\u00B7\uF0B7]+)?\s*(?=\n|$)/);
    expect(result.content.toLowerCase()).toContain("aluminum window");
    expect((result.citations ?? []).length).toBeGreaterThan(0);
    expect((result.citations ?? []).every((citation) => [255, 256].includes(citation.pageNumber ?? -1))).toBe(true);
  });

  it("returns exact indexed text when user explicitly asks to review a section", async () => {
    const activeFileId = asUuid("file-active-section-review");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 4,
      chunks: [
        {
          chunkIndex: 617,
          chunkText: "3.52. EXPANSION JOINT ASSEMBLIES 3.52.1. Submittals Build mockup of typical expansion joint assembly.",
          tokenCount: 23,
          pageNumber: 251,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 618,
          chunkText: "Warranty on Painted Finishes: manufacturer agrees to repair finish or replace roof expansion joints.",
          tokenCount: 16,
          pageNumber: 251,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 619,
          chunkText: "3.52.4. Manufactured Roof Expansion Joint (NOT USED) 3.52.5. Interior and exterior floor, wall, and ceiling expansion joint covers.",
          tokenCount: 23,
          pageNumber: 252,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 626,
          chunkText: "3.54. SHEET METAL FLASHING 3.54.1. Samples.",
          tokenCount: 8,
          pageNumber: 255,
          sectionLabel: "3.54. SHEET METAL FLASHING",
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-section-review"),
      "review section 3.52",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.content).toContain("## Section 3.52");
    expect(result.content).toContain("```text");
    expect(result.content).toContain("Warranty on Painted Finishes");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.suggestedPages).toEqual(expect.arrayContaining([251, 252]));
    expect((result.citations ?? []).every((citation) => [251, 252].includes(citation.pageNumber ?? -1))).toBe(true);
  });

  it("returns exact indexed text for explicit review of a different section anchor", async () => {
    const activeFileId = asUuid("file-active-section-353");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["windows", "expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 5,
      chunks: [
        {
          chunkIndex: 619,
          chunkText: "3.52.5. Interior and exterior floor, wall, and ceiling expansion joint covers.",
          tokenCount: 14,
          pageNumber: 252,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
        {
          chunkIndex: 626,
          chunkText: "3.53. ALUMINUM WINDOWS 3.53.1. Performance requirements and quality assurance.",
          tokenCount: 16,
          pageNumber: 255,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 627,
          chunkText: "Provide thermally broken aluminum window framing and glazing as indicated.",
          tokenCount: 12,
          pageNumber: 255,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 628,
          chunkText: "Window hardware and finish requirements for aluminum windows.",
          tokenCount: 10,
          pageNumber: 256,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 632,
          chunkText: "3.54. SHEET METAL FLASHING.",
          tokenCount: 6,
          pageNumber: 258,
          sectionLabel: "3.54. SHEET METAL FLASHING",
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-section-353"),
      "review section 3.53",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.content).toContain("## Section 3.53");
    expect(result.content).toContain("ALUMINUM WINDOWS");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.suggestedPages).toEqual(expect.arrayContaining([255, 256]));
    expect((result.citations ?? []).every((citation) => [255, 256].includes(citation.pageNumber ?? -1))).toBe(true);
  });

  it("routes topic-style review prompts to exact section text when section evidence is clear", async () => {
    const activeFileId = asUuid("file-active-topic-review");
    const activeFileName = "A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf";

    vi.spyOn(retrievalService, "getDocumentDetail").mockResolvedValue({
      fileId: activeFileId,
      fileName: activeFileName,
      filePath: "05 - PRDC/A37806_Volume_05_Project_Requirements_and_Design_Criteria_CONFORMED.pdf",
      fileSize: 2500000,
      mimeType: "application/pdf",
      docCategory: "report",
      summary: "Requirements and design criteria.",
      keyTopics: ["windows", "expansion joints"],
      tags: ["volume", "conformed"],
      extractedFields: undefined,
      specSection: undefined,
      sheetNumber: undefined,
      revision: "05",
      indexStatus: "indexed",
      lastIndexed: new Date(),
      chunkCount: 4,
      chunks: [
        {
          chunkIndex: 626,
          chunkText: "3.53. ALUMINUM WINDOWS 3.53.1. Performance requirements and quality assurance.",
          tokenCount: 16,
          pageNumber: 255,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 627,
          chunkText: "Provide thermally broken aluminum window framing and glazing as indicated.",
          tokenCount: 12,
          pageNumber: 255,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 628,
          chunkText: "Window hardware and finish requirements for aluminum windows.",
          tokenCount: 10,
          pageNumber: 256,
          sectionLabel: "3.53. ALUMINUM WINDOWS",
        },
        {
          chunkIndex: 619,
          chunkText: "3.52.5. Interior and exterior floor, wall, and ceiling expansion joint covers.",
          tokenCount: 14,
          pageNumber: 252,
          sectionLabel: "3.52. EXPANSION JOINT ASSEMBLIES",
        },
      ],
      relatedDocuments: [],
    });

    const result = await chatCoordinatorService.generateReply(
      asUuid("project-active-topic-review"),
      "review aluminium windows",
      undefined,
      [{ fileName: activeFileName, fileId: activeFileId }],
      activeFileName,
      activeFileId
    );

    expect(result.content).toContain("## Section 3.53");
    expect(result.content).toContain("ALUMINUM WINDOWS");
    expect(result.content).toContain("thermally broken aluminum window");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.suggestedPages).toEqual(expect.arrayContaining([255, 256]));
    expect((result.citations ?? []).every((citation) => [255, 256].includes(citation.pageNumber ?? -1))).toBe(true);
  });

  it("logs route summary with retrieval policy and source page provenance", async () => {
    const infoSpy = vi.spyOn(logger, "info");

    vi.spyOn(retrievalService, "searchProject").mockResolvedValue({
      query: "",
      totalMatches: 1,
      searchedAt: new Date(),
      results: [
        {
          fileId: asUuid("file-route-log"),
          fileName: "route-log.pdf",
          filePath: "",
          docCategory: "report",
          tags: ["schedule"],
          matchedChunks: [
            {
              chunkId: "chunk-route-log",
              chunkIndex: 1,
              chunkText: "Critical path delay and schedule impact evidence.",
              relevance: 0.88,
              sourceType: "content",
              pageNumber: 11,
            },
          ],
          topRelevance: 0.88,
        },
      ],
    });

    await chatCoordinatorService.generateReply(
      asUuid("project-route-log"),
      "what schedule impact is shown",
      undefined,
      undefined,
      "route-log.pdf",
      asUuid("file-route-log")
    );

    const routeSummaryCall = infoSpy.mock.calls.find((call) => call[0] === "chat.coordinator.route_summary");
    expect(routeSummaryCall).toBeDefined();

    const payload = routeSummaryCall?.[1] as {
      retrievalPolicy?: {
        activeDocBoostEnabled?: boolean;
        citationFallbackEnabled?: boolean;
        activeDocBoostApplied?: boolean;
        selectedFileName?: string;
      };
      sourcePageProvenance?: {
        exact?: number;
        fallback?: number;
        mixed?: number;
        none?: number;
      };
    };

    expect(payload.retrievalPolicy?.activeDocBoostEnabled).toBe(true);
    expect(payload.retrievalPolicy?.citationFallbackEnabled).toBe(true);
    expect(payload.retrievalPolicy?.selectedFileName).toBe("route-log.pdf");
    expect(payload.sourcePageProvenance?.exact).toBeGreaterThanOrEqual(1);
  });
});
