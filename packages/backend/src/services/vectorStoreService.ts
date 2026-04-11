/**
 * 6.2 Vector Store Integration Service (Pinecone)
 * Handles embeddings, indexing, and vector operations
 */

import { Pinecone } from '@pinecone-database/pinecone';
import { OpenAI } from 'openai';
import { Vector, VectorMetadata } from '../types/rag';

export class VectorStoreService {
  private pinecone: Pinecone;
  private openai: OpenAI;
  private indexName: string;
  private embeddingModel: string = 'text-embedding-3-small';

  constructor(indexName: string = 'projectdashboard') {
    this.pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.indexName = indexName;
  }

  /**
   * Generate embeddings for text using OpenAI
   * @param texts Array of texts to embed
   * @returns Array of embedding vectors
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.openai.embeddings.create({
        input: texts,
        model: this.embeddingModel,
      });

      return response.data.map((d) => d.embedding);
    } catch (error) {
      console.error('Failed to generate embeddings:', error);
      throw error;
    }
  }

  /**
   * Upsert vectors into Pinecone index
   * @param vectors Array of vectors to upsert
   */
  async upsertVectors(vectors: Vector[]): Promise<void> {
    try {
      const index = this.pinecone.Index(this.indexName);

      // Batch vectors in groups of 100 (Pinecone limit)
      const batchSize = 100;
      for (let i = 0; i < vectors.length; i += batchSize) {
        const batch = vectors.slice(i, i + batchSize);

        await index.upsert(
          batch.map((v) => ({
            id: v.id,
            values: v.values,
            metadata: v.metadata as Record<string, any>,
          }))
        );
      }

      console.log(`✅ Upserted ${vectors.length} vectors to Pinecone`);
    } catch (error) {
      console.error('Failed to upsert vectors:', error);
      throw error;
    }
  }

  /**
   * Query similar vectors from Pinecone
   * @param queryVector Embedding vector to query
   * @param topK Number of results to return
   * @param filter Metadata filter for results
   * @returns Array of matching vectors with scores
   */
  async searchVectors(
    queryVector: number[],
    topK: number = 10,
    filter?: Record<string, any>
  ): Promise<
    Array<{
      id: string;
      score: number;
      metadata: VectorMetadata;
    }>
  > {
    try {
      const index = this.pinecone.Index(this.indexName);

      const results = await index.query({
        vector: queryVector,
        topK,
        includeMetadata: true,
        filter: filter ? { $and: [filter] } : undefined,
      });

      return results.matches.map((match) => ({
        id: match.id,
        score: match.score || 0,
        metadata: (match.metadata as VectorMetadata) || {},
      }));
    } catch (error) {
      console.error('Failed to search vectors:', error);
      throw error;
    }
  }

  /**
   * Delete vectors by IDs
   * @param vectorIds Array of vector IDs to delete
   */
  async deleteVectors(vectorIds: string[]): Promise<void> {
    try {
      const index = this.pinecone.Index(this.indexName);

      // Batch deletions in groups of 100
      const batchSize = 100;
      for (let i = 0; i < vectorIds.length; i += batchSize) {
        const batch = vectorIds.slice(i, i + batchSize);
        await index.deleteMany(batch);
      }

      console.log(`✅ Deleted ${vectorIds.length} vectors from Pinecone`);
    } catch (error) {
      console.error('Failed to delete vectors:', error);
      throw error;
    }
  }

  /**
   * Delete vectors by metadata filter
   * @param filter Metadata filter
   */
  async deleteByFilter(filter: Record<string, any>): Promise<void> {
    try {
      const index = this.pinecone.Index(this.indexName);
      await index.deleteMany({ filter });
      console.log('✅ Vectors deleted by filter');
    } catch (error) {
      console.error('Failed to delete by filter:', error);
      throw error;
    }
  }

  /**
   * Ingest document chunks into vector store
   * Converts chunks from database into vectors and stores in Pinecone
   * @param chunks Array of chunks to ingest {id, chunkText, metadata}
   */
  async ingestChunks(
    chunks: Array<{
      id: string;
      chunkText: string;
      metadata: VectorMetadata;
    }>
  ): Promise<void> {
    try {
      console.log(`📥 Ingesting ${chunks.length} chunks...`);

      // Extract texts for embedding
      const texts = chunks.map((c) => c.chunkText);

      // Generate embeddings
      console.log('🔢 Generating embeddings...');
      const embeddings = await this.generateEmbeddings(texts);

      // Create vectors for upsert
      const vectors: Vector[] = chunks.map((chunk, idx) => ({
        id: chunk.id,
        values: embeddings[idx],
        metadata: chunk.metadata,
      }));

      // Upsert to Pinecone
      await this.upsertVectors(vectors);

      console.log(`✅ Successfully ingested ${chunks.length} chunks`);
    } catch (error) {
      console.error('Failed to ingest chunks:', error);
      throw error;
    }
  }

  /**
   * Get index stats
   */
  async getIndexStats(): Promise<{
    totalVectors: number;
    dimension: number;
  }> {
    try {
      const index = this.pinecone.Index(this.indexName);
      const stats = await index.describeIndexStats();

      return {
        totalVectors: stats.totalRecordCount || 0,
        dimension: stats.dimension || 1536,
      };
    } catch (error) {
      console.error('Failed to get index stats:', error);
      throw error;
    }
  }

  /**
   * Estimate cost of embeddings
   * Uses OpenAI pricing: $0.02 per 1M input tokens (text-embedding-3-small)
   */
  estimateEmbeddingCost(tokenCount: number): number {
    const costPer1MTokens = 0.02;
    return (tokenCount / 1_000_000) * costPer1MTokens;
  }
}
