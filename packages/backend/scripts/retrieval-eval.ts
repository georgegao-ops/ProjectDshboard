import { config } from "dotenv";
import { initializeDb } from "../src/db";
import { getEnv } from "../src/config/env";
import { retrievalService } from "../src/services/retrieval.service";

type EvalCase = {
  id: string;
  projectId: string;
  query: string;
  topK?: number;
  expected?: {
    fileId?: string;
    fileNameIncludes?: string;
    anyPageIn?: number[];
    requiredTerms?: string[];
  };
};

type EvalResult = {
  id: string;
  query: string;
  topK: number;
  totalMatches: number;
  contextPrecisionAtK: number;
  citationReadyHitRateAtK: number;
  expectedFileHit: boolean;
  expectedPageHit: boolean;
  topFileNames: string[];
  topPages: number[];
  lexicalSummary: {
    maxQueryTermHitCount: number;
    maxRequiredTermHitCount: number;
    avgQueryTermHitCount: number;
    avgRequiredTermHitCount: number;
    chunksWithAnyQueryTerm: number;
    chunksWithAnyRequiredTerm: number;
  };
  lexicalDiagnostics: Array<{
    fileId: string;
    fileName: string;
    chunkId: string;
    chunkIndex: number;
    pageNumber?: number;
    retrievalRelevance: number;
    queryTermHitCount: number;
    requiredTermHitCount: number;
    termHits: Record<string, number>;
    snippet: string;
  }>;
};

function buildTermHitMap(text: string, terms: string[]): Record<string, number> {
  const lower = text.toLowerCase();
  const counts: Record<string, number> = {};
  for (const term of terms) {
    const normalizedTerm = term.trim().toLowerCase();
    if (!normalizedTerm) continue;
    counts[normalizedTerm] = lower.includes(normalizedTerm) ? 1 : 0;
  }
  return counts;
}

function countHitTerms(termHits: Record<string, number>): number {
  return Object.values(termHits).filter((value) => value > 0).length;
}

function parseArgs(argv: string[]): { casesFile?: string; topK?: number; failOnExpectationMiss: boolean } {
  const result: { casesFile?: string; topK?: number; failOnExpectationMiss: boolean } = {
    failOnExpectationMiss: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--cases" && next) {
      result.casesFile = next;
      i += 1;
      continue;
    }

    if (arg === "--topK" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        result.topK = parsed;
      }
      i += 1;
      continue;
    }

    if (arg === "--failOnExpectationMiss") {
      result.failOnExpectationMiss = true;
    }
  }

  return result;
}

async function loadCases(filePath?: string): Promise<EvalCase[]> {
  if (!filePath) {
    return [
      {
        id: "expansion-joint-volume-5",
        projectId: "26119b35-a446-4b58-bc4a-de07e133fbb1",
        query: "based off the volume 5 conformed prdc, what are the expansion joint specifications",
        topK: 12,
        expected: {
          fileId: "a67b41a8-7eab-49ad-a4b2-f2874b6be544",
          fileNameIncludes: "volume_05",
          anyPageIn: [251, 252],
          requiredTerms: ["expansion", "joint"],
        },
      },
      {
        id: "expansion-joint-volume-5-paraphrase",
        projectId: "26119b35-a446-4b58-bc4a-de07e133fbb1",
        query: "what are the requirements for expansion joints in volume 5 conformed prdc",
        topK: 12,
        expected: {
          fileId: "a67b41a8-7eab-49ad-a4b2-f2874b6be544",
          fileNameIncludes: "volume_05",
          anyPageIn: [251, 252],
          requiredTerms: ["expansion", "joint", "submittal", "warranty"],
        },
      },
    ];
  }

  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as EvalCase[];
  return parsed;
}

function includesAllTerms(text: string, terms?: string[]): boolean {
  if (!terms || terms.length === 0) return true;
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term.toLowerCase()));
}

function toUniqueSortedPages(pages: Array<number | undefined>): number[] {
  return Array.from(
    new Set(pages.filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0))
  ).sort((a, b) => a - b);
}

function scoreCase(result: Awaited<ReturnType<typeof retrievalService.searchProject>>, testCase: EvalCase, topK: number): EvalResult {
  const rows = result.results.slice(0, topK);
  const allChunks = rows.flatMap((row) => row.matchedChunks);
  const queryTerms = testCase.query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  const requiredTerms = testCase.expected?.requiredTerms ?? [];

  const relevantChunks = allChunks.filter((chunk) => includesAllTerms(chunk.chunkText, testCase.expected?.requiredTerms));
  const citationReadyChunks = relevantChunks.filter((chunk) => typeof chunk.pageNumber === "number");

  const contextPrecisionAtK = allChunks.length > 0 ? Number((relevantChunks.length / allChunks.length).toFixed(3)) : 0;
  const citationReadyHitRateAtK = allChunks.length > 0 ? Number((citationReadyChunks.length / allChunks.length).toFixed(3)) : 0;

  const expectedFileHit = rows.some((row) => {
    if (testCase.expected?.fileId && row.fileId === testCase.expected.fileId) {
      return true;
    }
    if (testCase.expected?.fileNameIncludes && row.fileName.toLowerCase().includes(testCase.expected.fileNameIncludes.toLowerCase())) {
      return true;
    }
    return false;
  });

  const topPages = toUniqueSortedPages(allChunks.map((chunk) => chunk.pageNumber));
  const expectedPageHit = Array.isArray(testCase.expected?.anyPageIn) && testCase.expected.anyPageIn.length > 0
    ? testCase.expected.anyPageIn.some((page) => topPages.includes(page))
    : true;

  const lexicalDiagnostics = rows
    .flatMap((row) =>
      row.matchedChunks.map((chunk) => {
        const queryTermHits = buildTermHitMap(chunk.chunkText, queryTerms);
        const requiredTermHits = buildTermHitMap(chunk.chunkText, requiredTerms);

        return {
          fileId: row.fileId,
          fileName: row.fileName,
          chunkId: chunk.chunkId,
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          retrievalRelevance: Number(chunk.relevance.toFixed(3)),
          queryTermHitCount: countHitTerms(queryTermHits),
          requiredTermHitCount: countHitTerms(requiredTermHits),
          termHits: {
            ...queryTermHits,
            ...requiredTermHits,
          },
          snippet: chunk.chunkText.slice(0, 220).replace(/\s+/g, " "),
        };
      })
    )
    .sort((left, right) => right.requiredTermHitCount - left.requiredTermHitCount || right.queryTermHitCount - left.queryTermHitCount)
    .slice(0, topK);

  const queryHitCounts = lexicalDiagnostics.map((entry) => entry.queryTermHitCount);
  const requiredHitCounts = lexicalDiagnostics.map((entry) => entry.requiredTermHitCount);
  const lexicalSummary = {
    maxQueryTermHitCount: queryHitCounts.length > 0 ? Math.max(...queryHitCounts) : 0,
    maxRequiredTermHitCount: requiredHitCounts.length > 0 ? Math.max(...requiredHitCounts) : 0,
    avgQueryTermHitCount: queryHitCounts.length > 0
      ? Number((queryHitCounts.reduce((sum, value) => sum + value, 0) / queryHitCounts.length).toFixed(3))
      : 0,
    avgRequiredTermHitCount: requiredHitCounts.length > 0
      ? Number((requiredHitCounts.reduce((sum, value) => sum + value, 0) / requiredHitCounts.length).toFixed(3))
      : 0,
    chunksWithAnyQueryTerm: queryHitCounts.filter((value) => value > 0).length,
    chunksWithAnyRequiredTerm: requiredHitCounts.filter((value) => value > 0).length,
  };

  return {
    id: testCase.id,
    query: testCase.query,
    topK,
    totalMatches: result.totalMatches,
    contextPrecisionAtK,
    citationReadyHitRateAtK,
    expectedFileHit,
    expectedPageHit,
    topFileNames: rows.map((row) => row.fileName),
    topPages,
    lexicalSummary,
    lexicalDiagnostics,
  };
}

async function main(): Promise<void> {
  config({ path: "../../.env" });

  const args = parseArgs(process.argv.slice(2));
  const cases = await loadCases(args.casesFile);

  const env = getEnv();
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is missing");
  }

  await initializeDb(env.databaseUrl);

  const results: EvalResult[] = [];
  for (const testCase of cases) {
    const topK = testCase.topK ?? args.topK ?? 12;
    const retrieval = await retrievalService.searchProject(testCase.projectId as any, testCase.query, {
      topK,
      includeChunks: true,
    });

    results.push(scoreCase(retrieval, testCase, topK));
  }

  const aggregate = {
    caseCount: results.length,
    avgContextPrecisionAtK: Number((results.reduce((sum, row) => sum + row.contextPrecisionAtK, 0) / Math.max(1, results.length)).toFixed(3)),
    avgCitationReadyHitRateAtK: Number((results.reduce((sum, row) => sum + row.citationReadyHitRateAtK, 0) / Math.max(1, results.length)).toFixed(3)),
    expectedFileHitRate: Number((results.filter((row) => row.expectedFileHit).length / Math.max(1, results.length)).toFixed(3)),
    expectedPageHitRate: Number((results.filter((row) => row.expectedPageHit).length / Math.max(1, results.length)).toFixed(3)),
  };

  console.log(JSON.stringify({ aggregate, results }, null, 2));

  if (args.failOnExpectationMiss) {
    const misses = results.filter((row) => !row.expectedFileHit || !row.expectedPageHit);
    if (misses.length > 0) {
      const ids = misses.map((row) => row.id).join(", ");
      throw new Error(`retrieval_eval_expectation_miss:${ids}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
