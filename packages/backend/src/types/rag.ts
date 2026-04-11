/**
 * Shared types for Chat/RAG system
 */

// ============================================================================
// Query Processing (6.1)
// ============================================================================

export interface ParsedQuery {
  rawQuery: string;
  specSection?: string; // e.g., "23 05 00"
  topics: string[];
  keywords: string[];
  confidence: number; // 0-1
}

// ============================================================================
// Vector Store (6.2)
// ============================================================================

export interface VectorMetadata {
  projectId: string;
  fileId: string;
  fileName: string;
  fileType: string;
  specSection?: string;
  category?: string;
  chunkIndex: number;
  chunkText: string;
  createdAt: string;
  oneDriveLink?: string;
}

export interface Vector {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

// ============================================================================
// Hybrid Search (6.3)
// ============================================================================

export interface SearchFilter {
  projectId: string;
  specSection?: string;
  category?: string;
  tags?: string[];
  createdAfter?: Date;
}

export interface SearchResult {
  vectorId: string;
  fileId: string;
  fileName: string;
  fileType: string;
  specSection?: string;
  category?: string;
  chunkIndex: number;
  chunkText: string;
  relevanceScore: number;
  metadataMatchScore: number;
  combinedScore: number;
  oneDriveLink?: string;
}

// ============================================================================
// Context Assembly (6.4)
// ============================================================================

export interface Citation {
  fileId: string;
  fileName: string;
  chunkIndex: number;
  relevance: number;
  oneDriveLink?: string;
}

export interface AssembledContext {
  chunks: SearchResult[];
  totalTokens: number;
  tokenBudget: number;
  citations: Citation[];
  metadata: {
    timestamp: string;
    queryCount: number;
    averageRelevance: number;
  };
}

// ============================================================================
// LLM Response (6.5)
// ============================================================================

export interface LLMRequest {
  userQuery: string;
  context: AssembledContext;
  conversationHistory?: ConversationMessage[];
  systemPrompt?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: Citation[];
}

export interface StreamEvent {
  type:
    | 'response_start'
    | 'response_chunk'
    | 'response_end'
    | 'sources'
    | 'error';
  data: string | SearchResult[] | Error;
  timestamp: string;
}

export interface LLMResponse {
  messageId: string;
  responseText: string;
  citations: Citation[];
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  generatedAt: string;
}

// ============================================================================
// WebSocket/Chat (6.6)
// ============================================================================

export interface ChatQuery {
  sessionId: string;
  userId: string;
  projectId: string;
  message: string;
  timestamp: string;
}

export interface WebSocketMessage {
  type:
    | 'query'
    | 'response'
    | 'chunk'
    | 'sources'
    | 'complete'
    | 'error'
    | 'typing';
  payload: any;
  timestamp: string;
}

// ============================================================================
// Configuration
// ============================================================================

export interface RAGConfig {
  // Query parsing
  queryParser: {
    enableHaikuFallback: boolean;
  };

  // Vector store
  vectorStore: {
    provider: 'pinecone' | 'pgvector';
    apiKey: string;
    environment?: string;
    indexName: string;
  };

  // Search
  search: {
    topK: number; // Number of vectors to retrieve
    maxResults: number; // Number of results to return
    minRelevance: number; // Minimum relevance score
  };

  // Context assembly
  context: {
    tokenBudget: number; // Max tokens for context (~2500)
    maxChunks: number; // Max chunks to include
  };

  // LLM
  llm: {
    model: string; // 'claude-3-5-sonnet-20241022'
    maxTokens: number; // Max tokens for response
    temperature: number; // 0-1
    systemPrompt: string;
  };

  // Cost tracking
  costTracking: {
    enabled: boolean;
    embeddingCost: number; // per 1K tokens
    llmInputCost: number; // per 1M tokens
    llmOutputCost: number; // per 1M tokens
  };
}
