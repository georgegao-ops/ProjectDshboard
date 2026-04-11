# Chat/RAG System Implementation

> Construction document question-answering system powered by hybrid search + Claude AI

## Overview

The Chat/RAG (Retrieval-Augmented Generation) system enables intelligent searching and answering of questions about construction documents. It combines:

- **6.1 Query Processing**: Natural language parsing with CSI MasterFormat support
- **6.2 Vector Store**: Pinecone integration for semantic search
- **6.3 Hybrid Search**: Combined metadata + vector search with intelligent ranking
- **6.4 Context Assembly**: Smart chunk selection within token budgets
- **6.5 LLM Generation**: Claude Sonnet 3.5 for high-quality responses
- **6.6 WebSocket Streaming**: Real-time response delivery to frontend

## Architecture

```
User Query
    ↓
[6.1] QueryParser: Extract structure (spec_section, topics)
    ↓
[6.2] Embeddings: Generate vector via OpenAI
    ↓
[6.3] HybridSearch: Metadata filter + vector search
    ↓
[6.4] ContextAssembler: Select top chunks, manage tokens
    ↓
[6.5] LLMResponder: Claude Sonnet with streaming
    ↓
[6.6] WebSocket: Real-time delivery of response chunks + sources
```

## Setup

### 1. Environment Variables

Copy `.env.example` and add your API keys:

```bash
# .env.local
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
PINECONE_API_KEY=pcsk_...
PINECONE_INDEX=projectdashboard
DATABASE_URL=postgresql://...
```

### 2. Install Dependencies

```bash
cd ProjectDshboard-backend/packages/backend
npm install
```

New dependencies added:
- `@anthropic-ai/sdk` - Claude API
- `@pinecone-database/pinecone` - Vector database
- `openai` - Embeddings
- `js-tiktoken` - Token counting
- `ws` - WebSocket support

### 3. Vector Store Setup

Initialize Pinecone index:

```bash
# Create index (if not exists)
# Name: projectdashboard
# Dimension: 1536 (text-embedding-3-small)
# Metric: cosine
```

Ingest document chunks:

```typescript
import { VectorStoreService } from './services/vectorStoreService';

const vectorStore = new VectorStoreService('projectdashboard');

// Fetch chunks from database and ingest
const chunks = await db.query.vectorChunks.findMany({
  where: eq(vectorChunks.fileId, fileId),
});

await vectorStore.ingestChunks(chunks.map(c => ({
  id: c.id,
  chunkText: c.chunkText,
  metadata: {
    projectId,
    fileId: c.fileId,
    fileName,
    fileType,
    specSection,
    category,
    chunkIndex: c.chunkIndex,
    chunkText: c.chunkText,
    createdAt: c.createdAt.toISOString(),
  }
})));
```

## API Endpoints

### HTTP Endpoints

#### Create Chat Session
```
POST /api/rag/sessions
Body: { projectId: string, userId: string }
Response: { sessionId: string, createdAt: string }
```

#### Send Chat Query (HTTP)
```
POST /api/rag/chat
Body: {
  sessionId?: string,
  projectId: string,
  userId: string,
  message: string
}
Response: {
  messageId: string,
  responseText: string,
  citations: [{
    fileId: string,
    fileName: string,
    chunkIndex: number,
    relevance: number,
    oneDriveLink?: string
  }],
  tokenUsage: {
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
    estimatedCost: number
  }
}
```

#### Get Chat History
```
GET /api/rag/sessions/:id/history?limit=50
Response: {
  sessionId: string,
  messages: [{
    id: string,
    role: 'user' | 'assistant',
    content: string,
    sources?: [{
      fileId: string,
      fileName: string,
      chunkIndex: number,
      relevance: number,
      link?: string
    }],
    createdAt: string
  }]
}
```

#### Health Check
```
GET /api/rag/health
Response: {
  status: 'healthy',
  components: {
    orchestrator: string,
    queryParser: string,
    vectorStore: string,
    llmResponder: string
  }
}
```

#### Get Configuration
```
GET /api/rag/config
Response: { RAGConfig object with all settings }
```

### WebSocket Endpoint

```
ws://localhost:3000/ws/chat
```

#### Send Query
```json
{
  "sessionId": "session-xxx",
  "projectId": "proj-xxx",
  "userId": "user-xxx",
  "message": "What does spec section 23 05 00 say about insulation?"
}
```

#### Receive Events

1. **response_start**
```json
{
  "type": "response_start",
  "data": "Starting response generation...",
  "timestamp": "2024-04-11T..."
}
```

2. **response_chunk** (streaming)
```json
{
  "type": "response_chunk",
  "data": "The specification for insulation...",
  "timestamp": "2024-04-11T..."
}
```

3. **sources**
```json
{
  "type": "sources",
  "data": [{
    "fileId": "file-xxx",
    "fileName": "Spec_Section_23.pdf",
    "chunkIndex": 5,
    "relevance": 0.92,
    "oneDriveLink": "https://..."
  }],
  "timestamp": "2024-04-11T..."
}
```

4. **response_end**
```json
{
  "type": "response_end",
  "data": "Response complete",
  "timestamp": "2024-04-11T..."
}
```

5. **error**
```json
{
  "type": "error",
  "data": "Error message",
  "timestamp": "2024-04-11T..."
}
```

## Usage Examples

### TypeScript Backend
```typescript
import { ragOrchestrator } from './services/ragOrchestrator';

// Execute full RAG pipeline
const response = await ragOrchestrator.executeRAG(
  "What is the required R-value for wall insulation?",
  projectId,
  conversationHistory,
  (event) => {
    console.log('Event:', event.type, event.data);
  }
);

console.log('Response:', response.responseText);
console.log('Sources:', response.citations);
console.log('Cost: $' + response.tokenUsage.estimatedCost.toFixed(4));
```

### JavaScript Frontend (HTTP)
```javascript
const response = await fetch('/api/rag/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sessionId: 'session-123',
    projectId: 'proj-456',
    userId: 'user-789',
    message: 'What does the spec say about waterproofing?'
  })
});

const data = await response.json();
console.log(data.data.responseText);
data.data.citations.forEach(c => {
  console.log(`Source: ${c.fileName} - ${c.oneDriveLink}`);
});
```

### JavaScript Frontend (WebSocket)
```javascript
const ws = new WebSocket('ws://localhost:3000/ws/chat');

ws.onopen = () => {
  ws.send(JSON.stringify({
    sessionId: 'session-123',
    projectId: 'proj-456',
    userId: 'user-789',
    message: 'What materials are required for the roof?'
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  
  switch(msg.type) {
    case 'response_chunk':
      // Append to UI in real-time
      console.log('Chunk:', msg.data);
      break;
    case 'sources':
      // Display citations
      msg.data.forEach(src => {
        console.log(`${src.fileName}: ${src.oneDriveLink}`);
      });
      break;
    case 'response_end':
      console.log('Done!');
      break;
  }
};
```

## Query Processing Examples

The system automatically extracts structured information:

```
User: "What does spec section 23 05 00 say about insulation?"
Parsed:
  - specSection: "23 05 00"
  - topics: ["insulation"]
  - keywords: ["insulation"]
  - confidence: 0.95

User: "Tell me about fire-rated walls in the specs"
Parsed:
  - specSection: undefined (looked for pattern but found none)
  - topics: ["fire-rated"]
  - keywords: ["fire", "rated", "walls"]
  - confidence: 0.65 (low, triggers Haiku fallback for precision)
```

## Cost Model

### Per-Query Costs

1. **Embedding Generation**: ~$0.0001
   - text-embedding-3-small: $0.02 per 1M tokens
   - Query: ~50 tokens average

2. **LLM Response**: ~$0.01-0.03
   - claude-3-5-sonnet-20241022
   - Input: ~3K tokens average ($3 per 1M)
   - Output: ~500 tokens average ($15 per 1M)

### Daily Estimate
- 20 queries/day
- ~$0.50/day total
- ~$15/month

## Performance Tuning

### Search Tuning
```typescript
searchEngine.setMinRelevance(0.4);  // Lower threshold = more results
searchEngine.setMaxResults(5);      // Fewer results = faster
```

### Context Tuning
```typescript
const assembler = new ContextAssembler(
  3000,  // Larger token budget = more context
  15     // More chunks = slower but more complete
);
```

### LLM Tuning
```typescript
const responder = new LLMResponder({
  model: 'claude-3-5-sonnet-20241022',
  maxTokens: 2048,      // Longer responses
  temperature: 0.5      // Lower = more precise
});
```

## Monitoring

### Health Check
```bash
curl http://localhost:3000/api/rag/health
```

### View Configuration
```bash
curl http://localhost:3000/api/rag/config
```

### Database Query to Check Vectors
```sql
SELECT COUNT(*) as vector_count FROM vector_chunks;
SELECT * FROM file_records WHERE spec_section = '23 05 00';
SELECT * FROM chat_messages WHERE role = 'assistant' LIMIT 10;
```

## Troubleshooting

### No Search Results
1. Check Pinecone index has vectors: `GET /api/rag/health`
2. Verify chunks exist in database
3. Lower `minRelevance` threshold temporarily

### LLM Responses Too Generic
1. Increase context token budget
2. Lower `temperature` for more deterministic responses
3. Verify system prompt is appropriate

### High Costs
1. Reduce `maxTokens` for LLM responses
2. Reduce `tokenBudget` for context
3. Lower `topK` for vector search

### WebSocket Connection Errors
1. Verify WS URL is correct
2. Check CORS settings for origin
3. Ensure port 3000 is accessible

## Files Created

### Services (6 Components)
- `services/queryParser.ts` - Query parsing & extraction
- `services/vectorStoreService.ts` - Pinecone integration
- `services/hybridSearchService.ts` - Metadata + vector search
- `services/contextAssembler.ts` - Context assembly & ranking
- `services/llmResponder.ts` - Claude Sonnet integration
- `services/ragOrchestrator.ts` - Pipeline orchestrator

### Routes & WebSocket
- `routes/ragRoutes.ts` - HTTP endpoints + WebSocket setup

### Types
- `types/rag.ts` - All type definitions

### Updates
- `server.ts` - WebSocket setup & route registration
- `.env.example` - Environment configuration

## Next Steps

1. **Test the pipeline end-to-end**
   ```bash
   npm run dev
   curl http://localhost:3000/api/rag/health
   ```

2. **Ingest sample documents**
   - Upload PDFs via OneDrive
   - Run indexing pipeline
   - Verify vectors in Pinecone

3. **Test chat queries**
   - Use WebSocket client in browser
   - Try HTTP endpoint
   - Monitor costs and token usage

4. **Deploy to production**
   - Set production environment variables
   - Configure CloudFlare for WebSocket support
   - Set up monitoring and error tracking

## References

- [Anthropic Claude API](https://docs.anthropic.com)
- [Pinecone Documentation](https://docs.pinecone.io)
- [OpenAI Embeddings](https://platform.openai.com/docs/guides/embeddings)
- [CSI MasterFormat](https://www.csinet.org/masterformat)
