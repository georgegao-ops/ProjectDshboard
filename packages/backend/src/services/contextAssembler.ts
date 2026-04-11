/**
 * 6.4 Context Assembly & Ranking Service
 * Builds coherent context from search results for LLM consumption
 */

import { encoding_for_model } from 'js-tiktoken';
import { SearchResult, AssembledContext, Citation } from '../types/rag';

export class ContextAssembler {
  private tokenBudget: number;
  private maxChunks: number;
  private tokenEncoder: ReturnType<typeof encoding_for_model>;

  constructor(tokenBudget: number = 2500, maxChunks: number = 10) {
    this.tokenBudget = tokenBudget;
    this.maxChunks = maxChunks;

    // Use claude tokenizer (approximate, uses gpt-3.5-turbo encoding as proxy)
    try {
      this.tokenEncoder = encoding_for_model('gpt-3.5-turbo');
    } catch {
      // Fallback if model not available
      this.tokenEncoder = encoding_for_model('text-davinci-003');
    }
  }

  /**
   * Assemble context from search results
   * Selects top chunks and assembles into coherent context
   * @param searchResults Ranked search results from hybrid search
   * @param userQuery Original user query (for context)
   * @returns Assembled context ready for LLM
   */
  async assembleContext(
    searchResults: SearchResult[],
    userQuery: string
  ): Promise<AssembledContext> {
    try {
      console.log('🔧 Assembling context...');

      // Step 1: Select top chunks within token budget
      const selectedChunks = this.selectChunks(searchResults);

      console.log(
        `✅ Selected ${selectedChunks.length} chunks for context`
      );

      // Step 2: Calculate actual token count
      const contextText = this.buildContextText(selectedChunks);
      const totalTokens = this.countTokens(contextText);

      console.log(`📊 Context tokens: ${totalTokens}/${this.tokenBudget}`);

      // Step 3: Extract citations
      const citations = this.extractCitations(selectedChunks);

      // Step 4: Calculate metadata
      const metadata = {
        timestamp: new Date().toISOString(),
        queryCount: searchResults.length,
        averageRelevance:
          searchResults.length > 0
            ? searchResults.reduce(
                (sum, r) => sum + r.combinedScore,
                0
              ) / searchResults.length
            : 0,
      };

      return {
        chunks: selectedChunks,
        totalTokens,
        tokenBudget: this.tokenBudget,
        citations,
        metadata,
      };
    } catch (error) {
      console.error('Context assembly failed:', error);
      throw error;
    }
  }

  /**
   * Select chunks that fit within token budget
   * Greedy approach: take chunks in order until budget exhausted
   */
  private selectChunks(searchResults: SearchResult[]): SearchResult[] {
    const selected: SearchResult[] = [];
    let currentTokens = 0;

    // Reserve tokens for citations and formatting (~500 tokens)
    const reservedTokens = 500;
    const effectiveBudget = this.tokenBudget - reservedTokens;

    for (const result of searchResults) {
      // Estimate tokens for this chunk (conservative estimate)
      const chunkTokens = Math.ceil(result.chunkText.length / 4);

      // Check if adding this chunk would exceed budget
      if (currentTokens + chunkTokens <= effectiveBudget) {
        selected.push(result);
        currentTokens += chunkTokens;
      } else if (
        selected.length <
        this.maxChunks
      ) {
        // Add one more even if over budget to ensure we have content
        selected.push(result);
        break;
      } else {
        // Budget exhausted and max chunks reached
        break;
      }
    }

    return selected;
  }

  /**
   * Build formatted context text from chunks
   */
  private buildContextText(chunks: SearchResult[]): string {
    const sections = chunks.map((chunk, idx) => {
      const header = this.formatChunkHeader(chunk);
      return `[Source ${idx + 1}: ${header}]\n${chunk.chunkText}\n`;
    });

    return sections.join('\n---\n\n');
  }

  /**
   * Format header for a chunk with metadata
   */
  private formatChunkHeader(chunk: SearchResult): string {
    const parts = [];

    if (chunk.fileName) {
      parts.push(`📄 ${chunk.fileName}`);
    }

    if (chunk.specSection) {
      parts.push(`📋 Section ${chunk.specSection}`);
    }

    if (chunk.category) {
      parts.push(chunk.category);
    }

    if (chunk.chunkIndex !== undefined) {
      parts.push(`Part ${chunk.chunkIndex + 1}`);
    }

    return parts.join(' • ');
  }

  /**
   * Extract citations from chunks
   */
  private extractCitations(chunks: SearchResult[]): Citation[] {
    return chunks.map((chunk) => ({
      fileId: chunk.fileId,
      fileName: chunk.fileName,
      chunkIndex: chunk.chunkIndex,
      relevance: chunk.combinedScore,
      oneDriveLink: chunk.oneDriveLink,
    }));
  }

  /**
   * Count tokens in text
   * Uses js-tiktoken for estimation
   */
  private countTokens(text: string): number {
    try {
      return this.tokenEncoder.encode(text).length;
    } catch (error) {
      // Fallback: rough estimation (1 token ≈ 4 characters)
      console.warn('Token counting failed, using estimation');
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Format context for LLM prompt
   * Includes system instruction to cite sources
   */
  formatForPrompt(
    context: AssembledContext,
    userQuery: string
  ): {
    context: string;
    citations: Citation[];
    instruction: string;
  } {
    const contextText = this.buildContextText(context.chunks);

    const instruction = `You are a construction document assistant. Answer the user's question based ONLY on the provided context from construction documents. 

Important guidelines:
1. ALWAYS cite your sources by referencing the Source number in brackets, e.g., [Source 1]
2. If information is not in the provided context, say: "I don't have this information in the available documents."
3. Never fabricate specifications or requirements
4. Be precise and reference specific sections when available
5. If you're uncertain about something, express your confidence level

User Question: ${userQuery}

DOCUMENT CONTEXT:
`;

    return {
      context: instruction + '\n\n' + contextText,
      citations: context.citations,
      instruction,
    };
  }

  /**
   * Validate context has minimum content
   */
  static isContextSufficient(context: AssembledContext): boolean {
    return (
      context.chunks.length > 0 &&
      context.totalTokens >= 100 // At least some content
    );
  }

  /**
   * Get context statistics
   */
  getStats(context: AssembledContext): {
    chunkCount: number;
    totalTokens: number;
    tokenUtilization: number; // percentage
    averageRelevance: number;
  } {
    return {
      chunkCount: context.chunks.length,
      totalTokens: context.totalTokens,
      tokenUtilization:
        (context.totalTokens / context.tokenBudget) * 100,
      averageRelevance: context.metadata.averageRelevance,
    };
  }
}
