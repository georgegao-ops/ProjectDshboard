import type { SendChatMessageResponse, UUID } from "@contractor/shared";
import { embeddingsService } from "./embeddings.service";
import { projectService } from "./project.service";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export const retrievalService = {
  async retrieveSources(
    projectId: UUID | undefined,
    query = ""
  ): Promise<SendChatMessageResponse["sources"]> {
    if (!projectId || !query.trim()) {
      return [];
    }

    const queryEmbedding = await embeddingsService.embedText(query);
    const chunks = await projectService.listProjectChunks(projectId);
    if (chunks.length === 0) {
      return [];
    }

    const scored = chunks.map((chunk) => ({
      fileId: chunk.fileId,
      fileName: chunk.fileName,
      score: cosineSimilarity(queryEmbedding.vector, chunk.embedding),
    }));

    const deduped = new Map<string, { fileId: UUID; fileName: string; score: number }>();
    for (const candidate of scored) {
      const existing = deduped.get(candidate.fileId);
      if (!existing || candidate.score > existing.score) {
        deduped.set(candidate.fileId, {
          fileId: candidate.fileId,
          fileName: candidate.fileName,
          score: candidate.score,
        });
      }
    }

    return Array.from(deduped.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, 5)
      .map((entry) => ({
        fileId: entry.fileId,
        fileName: entry.fileName,
        relevance: Number(Math.max(0, Math.min(1, entry.score)).toFixed(3)),
      }));
  },
};
