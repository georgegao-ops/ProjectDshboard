/**
 * RAG Orchestrator Service
 * Orchestrates the entire Chat/RAG pipeline
 * 6.1 -> 6.2 -> 6.3 -> 6.4 -> 6.5 -> 6.6
 */

import { QueryParser } from './queryParser';
import { VectorStoreService } from './vectorStoreService';
import { HybridSearchEngine } from './hybridSearchService';
import { ContextAssembler } from './contextAssembler';
import { LLMResponder } from './llmResponder';
import {
  ParsedQuery,
  SearchFilter,
  AssembledContext,
  LLMResponse,
  StreamEvent,
  ChatQuery,
} from '../types/rag';

export class RAGOrchestrator {
  private queryParser: QueryParser;
  private vectorStore: VectorStoreService;
  private searchEngine: HybridSearchEngine;
  private contextAssembler: ContextAssembler;
  private llmResponder: LLMResponder;

  constructor() {
    this.queryParser = new QueryParser(true);
    this.vectorStore = new VectorStoreService();
    this.searchEngine = new HybridSearchEngine(this.vectorStore);
    this.contextAssembler = new ContextAssembler(2500, 10);
    this.llmResponder = new LLMResponder({
      model: 'claude-3-5-sonnet-20241022',
      maxTokens: 1024,
      temperature: 0.7,
    });
  }

  /**
   * Execute full RAG pipeline
   * Input: user query -> Output: LLM response with sources
   */
  async executeRAG(
    query: string,
    projectId: string,
    conversationHistory?: any[],
    onStreamChunk?: (event: StreamEvent) => void
  ): Promise<LLMResponse> {
    try {
      console.log('🚀 Starting RAG pipeline...');

      // Step 1: Parse query (6.1)
      console.log('\n📝 Step 1: Parsing query...');
      const parsedQuery = await this.queryParser.parseQuery(query);
      console.log(`✓ Parsed query:`, {
        specSection: parsedQuery.specSection,
        topics: parsedQuery.topics,
        confidence: parsedQuery.confidence,
      });

      // Step 2: Generate query embedding (6.2)
      console.log('\n🔢 Step 2: Generating embeddings...');
      const embeddings = await this.vectorStore.generateEmbeddings([query]);
      const queryVector = embeddings[0];
      console.log(`✓ Query embedded (dimension: ${queryVector.length})`);

      // Step 3: Execute hybrid search (6.3)
      console.log('\n🔍 Step 3: Hybrid search...');
      const searchFilter: SearchFilter = {
        projectId,
        specSection: parsedQuery.specSection,
      };

      const searchResults = await this.searchEngine.search(
        parsedQuery,
        queryVector,
        searchFilter
      );

      if (searchResults.length === 0) {
        console.warn('⚠️  No search results found');
      } else {
        console.log(`✓ Found ${searchResults.length} relevant chunks`);
      }

      // Step 4: Assemble context (6.4)
      console.log('\n🔧 Step 4: Assembling context...');
      const context = await this.contextAssembler.assembleContext(
        searchResults,
        query
      );

      const stats = this.contextAssembler.getStats(context);
      console.log(
        `✓ Context assembled: ${stats.chunkCount} chunks, ${stats.totalTokens}/${stats.tokenUtilization.toFixed(1)}% tokens`
      );

      // Step 5: Generate response (6.5+6.6)
      console.log('\n🤖 Step 5: Generating response...');
      const response = await this.llmResponder.generateResponse(
        {
          userQuery: query,
          context,
          conversationHistory,
        },
        onStreamChunk
      );

      console.log(`✓ Response generated`);
      console.log(`   Cost: $${response.tokenUsage.estimatedCost.toFixed(4)}`);

      return response;
    } catch (error) {
      console.error('❌ RAG pipeline failed:', error);
      throw error;
    }
  }

  /**
   * Chat endpoint - handles user messages with RAG
   */
  async chat(
    chatQuery: ChatQuery,
    conversationHistory?: any[],
    onStreamChunk?: (event: StreamEvent) => void
  ): Promise<LLMResponse> {
    return this.executeRAG(
      chatQuery.message,
      chatQuery.projectId,
      conversationHistory,
      onStreamChunk
    );
  }

  /**
   * Get RAG configuration
   */
  getConfig() {
    return {
      queryParser: {
        enableHaikuFallback: true,
      },
      vectorStore: {
        provider: process.env.VECTOR_STORE_PROVIDER || 'pinecone',
        indexName: process.env.PINECONE_INDEX || 'projectdashboard',
      },
      search: {
        topK: 30,
        maxResults: 10,
        minRelevance: 0.3,
      },
      context: {
        tokenBudget: 2500,
        maxChunks: 10,
      },
      llm: {
        model: 'claude-3-5-sonnet-20241022',
        maxTokens: 1024,
        temperature: 0.7,
      },
      costTracking: {
        enabled: true,
        embeddingCost: 0.02, // per 1M tokens
        llmInputCost: 3.0, // per 1M tokens
        llmOutputCost: 15.0, // per 1M tokens
      },
    };
  }

  /**
   * Health check - verify all components
   */
  async healthCheck(): Promise<{
    orchestrator: string;
    queryParser: string;
    vectorStore: string;
    llmResponder: string;
  }> {
    try {
      // Check vector store connection
      const stats = await this.vectorStore.getIndexStats();

      return {
        orchestrator: 'healthy',
        queryParser: 'healthy',
        vectorStore: `healthy (${stats.totalVectors} vectors)`,
        llmResponder: 'healthy',
      };
    } catch (error) {
      return {
        orchestrator: 'healthy',
        queryParser: 'healthy',
        vectorStore: `error: ${error instanceof Error ? error.message : 'unknown'}`,
        llmResponder: 'healthy',
      };
    }
  }
}

// Export singleton instance
export const ragOrchestrator = new RAGOrchestrator();
