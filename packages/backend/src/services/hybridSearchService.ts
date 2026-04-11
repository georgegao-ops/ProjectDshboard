/**
 * 6.3 Hybrid Search Engine
 * Combines metadata filtering + vector search with intelligent ranking
 */

import { SearchFilter, SearchResult, ParsedQuery } from '../types/rag';
import { VectorStoreService } from './vectorStoreService';
import { db } from '@contractor/data';
import { vectorChunks, fileRecords } from '@contractor/data/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

export class HybridSearchEngine {
  private vectorStore: VectorStoreService;
  private minRelevance: number;
  private maxResults: number;

  constructor(
    vectorStore?: VectorStoreService,
    config?: {
      minRelevance?: number;
      maxResults?: number;
    }
  ) {
    this.vectorStore = vectorStore || new VectorStoreService();
    this.minRelevance = config?.minRelevance || 0.3;
    this.maxResults = config?.maxResults || 10;
  }

  /**
   * Execute hybrid search combining metadata + vector search
   * @param parsedQuery Parsed query with structured hints
   * @param queryVector Embedding of user's query
   * @param filter Additional search filters
   * @returns Ranked search results
   */
  async search(
    parsedQuery: ParsedQuery,
    queryVector: number[],
    filter: SearchFilter
  ): Promise<SearchResult[]> {
    return this.hybridSearch(parsedQuery, queryVector, filter);
  }

  /**
   * Hybrid search implementation
   * 1. Apply metadata filters (spec_section, category, tags)
   * 2. Query vector store for semantic matches
   * 3. Merge and rank results by combined score
   */
  private async hybridSearch(
    parsedQuery: ParsedQuery,
    queryVector: number[],
    filter: SearchFilter
  ): Promise<SearchResult[]> {
    try {
      console.log('🔍 Starting hybrid search...');

      // Step 1: Get all files matching metadata filters
      const metadataMatches = await this.getMetadataMatches(
        filter,
        parsedQuery
      );

      if (metadataMatches.length === 0) {
        console.log('⚠️  No files matching metadata criteria');
        return [];
      }

      console.log(`📋 Found ${metadataMatches.length} files matching metadata`);

      // Get file IDs for vector filtering
      const matchingFileIds = metadataMatches.map((f) => f.id);

      // Step 2: Query vector store with metadata filter
      const vectorResults = await this.vectorStore.searchVectors(
        queryVector,
        30, // Get more results initially to account for filtering
        {
          projectId: filter.projectId,
          fileId: { $in: matchingFileIds },
        }
      );

      console.log(
        `🎯 Vector search returned ${vectorResults.length} results`
      );

      // Step 3: Fetch chunk details and combine with file metadata
      const searchResults: SearchResult[] = [];

      for (const vectorResult of vectorResults) {
        const file = metadataMatches.find(
          (f) => f.id === vectorResult.metadata.fileId
        );
        if (!file) continue;

        // Calculate metadata match score
        const metadataScore = this.calculateMetadataMatchScore(
          file,
          parsedQuery
        );

        // Combined score: 70% vector relevance + 30% metadata match
        const combinedScore = vectorResult.score * 0.7 + metadataScore * 0.3;

        if (combinedScore >= this.minRelevance) {
          searchResults.push({
            vectorId: vectorResult.id,
            fileId: vectorResult.metadata.fileId,
            fileName: file.fileName,
            fileType: file.fileType,
            specSection: file.specSection || undefined,
            category: file.docCategory || undefined,
            chunkIndex: vectorResult.metadata.chunkIndex,
            chunkText: vectorResult.metadata.chunkText,
            relevanceScore: vectorResult.score,
            metadataMatchScore: metadataScore,
            combinedScore,
            oneDriveLink: this.generateOneDriveLink(
              file.onedriveItemId,
              file.fileName
            ),
          });
        }
      }

      // Step 4: Sort by combined score and limit results
      const rankedResults = searchResults
        .sort((a, b) => b.combinedScore - a.combinedScore)
        .slice(0, this.maxResults);

      console.log(
        `✅ Hybrid search complete: ${rankedResults.length} results`
      );

      return rankedResults;
    } catch (error) {
      console.error('Hybrid search failed:', error);
      throw error;
    }
  }

  /**
   * Get all files matching metadata filters
   */
  private async getMetadataMatches(
    filter: SearchFilter,
    parsedQuery?: ParsedQuery
  ): Promise<any[]> {
    const conditions: any[] = [eq(fileRecords.projectId, filter.projectId)];

    // Add spec section filter if provided
    if (filter.specSection) {
      conditions.push(eq(fileRecords.specSection, filter.specSection));
    } else if (parsedQuery?.specSection) {
      // Use parsed spec section if available
      conditions.push(eq(fileRecords.specSection, parsedQuery.specSection));
    }

    // Add category filter if provided
    if (filter.category) {
      conditions.push(eq(fileRecords.docCategory, filter.category));
    }

    // Add tag filter if provided
    if (filter.tags && filter.tags.length > 0) {
      // This requires array overlap check in Postgres
      // For now, we'll filter in memory
    }

    // Add date filter if provided
    if (filter.createdAfter) {
      conditions.push(
        // Drizzle might need an alternative approach for date comparison
      );
    }

    const files = await db.query.fileRecords.findMany({
      where: conditions.length > 1 ? and(...conditions) : conditions[0],
    });

    // Apply tag filtering in memory if needed
    if (filter.tags && filter.tags.length > 0) {
      return files.filter((f: any) =>
        filter.tags?.some((tag) =>
          (f.tags || []).includes(tag)
        )
      );
    }

    return files;
  }

  /**
   * Calculate metadata match score (0-1)
   * Considers spec section match and category match
   */
  private calculateMetadataMatchScore(
    file: any,
    parsedQuery?: ParsedQuery
  ): number {
    let score = 0.5; // Base score

    // Spec section match
    if (
      parsedQuery?.specSection &&
      file.specSection === parsedQuery.specSection
    ) {
      score += 0.3; // Exact match
    } else if (parsedQuery?.specSection && file.specSection) {
      // Partial match (same division, different section)
      const querySections = parsedQuery.specSection.split(' ');
      const fileSections = file.specSection.split(' ');
      if (querySections[0] === fileSections[0]) {
        score += 0.1; // Same division
      }
    }

    // Topic/category match
    if (parsedQuery?.topics && parsedQuery.topics.length > 0) {
      const fileTopics = file.keyTopics || [];
      const matches = parsedQuery.topics.filter((t) =>
        fileTopics.some((ft: string) => ft.toLowerCase().includes(t))
      );
      score += (matches.length / parsedQuery.topics.length) * 0.2;
    }

    return Math.min(score, 1.0); // Cap at 1.0
  }

  /**
   * Generate OneDrive link from item ID
   */
  private generateOneDriveLink(
    onedriveItemId?: string,
    fileName?: string
  ): string | undefined {
    if (!onedriveItemId) return undefined;

    // Typical OneDrive link format
    // This would need to be customized based on your OneDrive setup
    const tenantId = process.env.ONEDRIVE_TENANT_ID || '';
    return `https://collab-my.sharepoint.com/personal/${tenantId}/Documents/${fileName}`;
  }

  /**
   * Set the minimum relevance threshold
   */
  setMinRelevance(threshold: number): void {
    if (threshold < 0 || threshold > 1) {
      throw new Error('Relevance threshold must be between 0 and 1');
    }
    this.minRelevance = threshold;
  }

  /**
   * Set maximum number of results
   */
  setMaxResults(max: number): void {
    if (max < 1) {
      throw new Error('Max results must be at least 1');
    }
    this.maxResults = max;
  }
}
