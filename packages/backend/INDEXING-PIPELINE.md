# ProjectDashboard Indexing Pipeline Documentation

## Overview

The Indexing Pipeline is the critical system that synchronizes documents from OneDrive with the ProjectDashboard database, processes them with AI-powered classification, and prepares them for semantic search via embeddings.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ ONEDRIVE DELTA SYNC (Step 1)                                │
│ - Call OneDrive /delta API periodically or on-demand         │
│ - Detect added/modified/deleted files via etag comparison    │
│ - Create file_records in PostgreSQL                          │
│ - Queue indexing jobs to Redis                               │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ DOCUMENT PROCESSING (Step 2)                                 │
│ - Download file from OneDrive to temp storage                │
│ - Extract text based on file type:                           │
│   • PDF: pdf-parse library                                   │
│   • DOCX: mammoth library                                    │
│   • Images: Tesseract OCR                                    │
│ - Classify with Claude Haiku LLM                             │
│ - Generate metadata (category, tags, summary, spec section)  │
│ - Update file_record in database                             │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ CHUNKING & EMBEDDING (Phase 3, Future)                       │
│ - Split text into 500-token chunks (50-token overlap)        │
│ - Generate embeddings with text-embedding-3-small            │
│ - Upsert vectors to Pinecone                                 │
│ - Update file_record.chunk_count                             │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ RAG INTEGRATION (Phase 4, Future)                            │
│ - Use vectors in chat semantic search                        │
│ - Retrieve relevant document chunks for context              │
└─────────────────────────────────────────────────────────────┘
```

## Database Schema

### sync_jobs
Tracks OneDrive sync operations for a project.

```sql
CREATE TABLE sync_jobs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  job_type TEXT NOT NULL, -- 'sync', 'index', 'reindex'
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  bulk_job_id TEXT, -- Reference to BullMQ job
  files_processed INTEGER DEFAULT 0,
  files_total INTEGER,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sync_jobs_project ON sync_jobs(project_id);
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status);
```

### indexing_jobs
Fine-grained tracking of individual file indexing.

```sql
CREATE TABLE indexing_jobs (
  id UUID PRIMARY KEY,
  file_id UUID NOT NULL REFERENCES file_records(id),
  sync_job_id UUID REFERENCES sync_jobs(id),
  bulk_job_id TEXT, -- Reference to BullMQ job
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  retries_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_indexing_jobs_file ON indexing_jobs(file_id);
CREATE INDEX idx_indexing_jobs_status ON indexing_jobs(status);
CREATE INDEX idx_indexing_jobs_sync ON indexing_jobs(sync_job_id);
```

### file_records (Enhanced)
Existing table with indexing-specific fields:

```sql
-- Key indexing fields in file_records table:
onedrive_etag TEXT -- For change detection
index_status TEXT DEFAULT 'pending' -- 'pending', 'processing', 'indexed', 'failed'
last_synced TIMESTAMPTZ
last_indexed TIMESTAMPTZ
chunk_count INTEGER DEFAULT 0

-- AI-generated metadata fields:
summary TEXT 
doc_category TEXT
spec_section TEXT
sheet_number TEXT
revision TEXT
key_topics TEXT[]
tags TEXT[]
```

## Services

### OneDriveService
Handles communication with OneDrive API and delta sync logic.

**Key Methods:**
```typescript
// Get delta changes from OneDrive
getDeltaChanges(accessToken: string, folderId: string): Promise<DeltaChange[]>

// Trigger sync: get changes, update DB, queue jobs
triggerSync(projectId: string, accessToken: string, indexQueue: Queue): Promise<{syncJobId, filesQueued}>

// Download file from OneDrive
downloadFile(accessToken: string, itemId: string, localPath: string): Promise<void>

// Token management
refreshToken(userId: string): Promise<OneDriveToken>
```

**Change Detection Logic:**
- Compares OneDrive etag with stored `fileRecords.onedrive_etag`
- If etag hasn't changed → skip file (no changes)
- If etag changed → re-process from Step 2
- If file deleted → soft-delete record, flag for vector removal

### DocumentProcessingService
Extracts text and classifies documents using AI.

**Key Methods:**
```typescript
// Extract text based on file type
extractText(filePath: string, fileType: string): Promise<string>

// Classify document with Claude Haiku
classifyDocument(text: string, fileName: string): Promise<DocumentMetadata>

// Full processing pipeline
processDocument(fileId: string, filePath: string, fileType: string, fileName: string, indexingJobId: string): Promise<void>
```

**Extracted Metadata:**
```typescript
interface DocumentMetadata {
  summary: string; // ≤500 chars
  category: 'submittal' | 'spec' | 'drawing' | 'rfi' | 'photo' | 'report' | 'other';
  specSection?: string; // CSI format, e.g., "23 05 00"
  sheetNumber?: string; // Drawing ID, e.g., "A101"
  revision?: string; // Version, e.g., "Rev 3"
  keyTopics: string[];
  tags: string[];
}
```

### IndexingQueueWorker
BullMQ worker that processes document processing jobs asynchronously.

**Configuration:**
- Queue: 'indexing'
- Concurrency: 3 (process up to 3 documents in parallel)
- Retries: 3 attempts with exponential backoff (2s initial delay)

**Job Processing:**
1. Fetch file_record from database
2. Download file from OneDrive
3. Call DocumentProcessingService.processDocument()
4. Update indexing_job status
5. Clean up temp files

### IndexingOrchestrator
High-level orchestration of the complete indexing pipeline.

**Key Methods:**
```typescript
// Start complete sync + processing
startIndexingSync(projectId: string, accessToken: string): Promise<{syncJobId, filesQueued, syncStatus}>

// Get sync progress
getSyncStatus(syncJobId: string): Promise<{status, progress%, filesProcessed, filesTotal}>

// Project-level statistics
getProjectIndexingStats(projectId: string): Promise<{files, queue}>

// Re-index single file or entire project
reindexFile(fileId: string): Promise<{success}>
reindexProject(projectId: string): Promise<{success, syncJobId, filesQueued}>

// Get failed files
getFailedIndexingJobs(projectId: string): Promise<Array<{fileId, fileName, errorDetails}>>
```

## API Endpoints

### Trigger Sync
```bash
POST /api/indexing/sync
Content-Type: application/json

{
  "projectId": "12345-abc",
  "accessToken": "OneDrive access token"
}

Response:
{
  "syncJobId": "uuid",
  "filesQueued": 42,
  "syncStatus": "queued"
}
```

### Get Sync Status
```bash
GET /api/indexing/sync/:syncJobId

Response:
{
  "id": "uuid",
  "projectId": "uuid",
  "status": "processing",
  "filesProcessed": 15,
  "filesTotal": 42,
  "progress": 35,
  "startedAt": "2026-04-11T10:00:00Z",
  "completedAt": null,
  "errorMessage": null
}
```

### Get Project Statistics
```bash
GET /api/indexing/projects/:projectId/stats

Response:
{
  "files": {
    "totalFiles": 150,
    "indexed": 145,
    "pending": 2,
    "processing": 1,
    "failed": 2,
    "indexingPercentage": 96
  },
  "queue": {
    "waiting": 2,
    "active": 1,
    "completed": 145,
    "failed": 2
  }
}
```

### Reindex Single File
```bash
POST /api/indexing/files/:fileId/reindex

Response:
{
  "success": true,
  "fileId": "uuid"
}
```

### Reindex Project
```bash
POST /api/indexing/projects/:projectId/reindex

Response:
{
  "success": true,
  "syncJobId": "uuid",
  "filesQueued": 150
}
```

### Get Failed Files
```bash
GET /api/indexing/projects/:projectId/failed

Response:
{
  "failed": [
    {
      "fileId": "uuid",
      "fileName": "document.pdf",
      "errorDetails": "Error message"
    }
  ]
}
```

### Queue Statistics
```bash
GET /api/indexing/queue/stats

Response:
{
  "waiting": 5,
  "active": 2,
  "completed": 1203,
  "failed": 8
}
```

## Cost Breakdown

For a mid-size project (2,000 documents, avg 15 pages each):

| Component | Cost |
|-----------|------|
| Text Extraction | Free (local tools: pdf-parse, mammoth, Tesseract) |
| Classification (Claude Haiku) | ~$0.15 for 600K tokens |
| Embeddings (text-embedding-3-small) | ~$10 for 500K chunks |
| Vector Storage (Pinecone) | Free (covers 500K+ vectors) |
| **Total First Index** | ~$10-15 per project |
| **Re-indexing** | ~$0.01-0.10 (only changed files) |

## Environment Variables

```env
# OneDrive OAuth
MICROSOFT_CLIENT_ID=your-client-id
MICROSOFT_CLIENT_SECRET=your-client-secret
REDIRECT_URI=http://localhost:3000/auth/callback

# Redis Queue
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_URL=redis://localhost:6379 (optional, overrides HOST/PORT)

# LLM (Claude)
ANTHROPIC_API_KEY=your-anthropic-api-key

# Embeddings (OpenAI)
OPENAI_API_KEY=your-openai-api-key

# Vector Store (Pinecone)
PINECONE_API_KEY=your-pinecone-key
PINECONE_INDEX_NAME=projectdashboard
```

## Running the Indexing Pipeline

### Prerequisites
1. PostgreSQL database with migrations applied
2. Redis server running (for job queue)
3. OneDrive OAuth credentials configured
4. Environment variables set

### Migrations
```bash
# Apply database migrations
npm run db:migrate

# Or manually:
psql -f src/migrations/001_initial.sql
psql -f src/migrations/002_add_sync_indexing_tables.sql
```

### Start Server
```bash
npm run dev
```

The IndexingQueueWorker will automatically initialize on server startup.

### Trigger a Sync
```bash
curl -X POST http://localhost:3000/api/indexing/sync \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "your-project-id",
    "accessToken": "your-onedrive-token"
  }'
```

### Monitor Progress
```bash
# Check sync status
curl http://localhost:3000/api/indexing/sync/{syncJobId}

# Check project stats
curl http://localhost:3000/api/indexing/projects/{projectId}/stats

# Check queue stats
curl http://localhost:3000/api/indexing/queue/stats
```

## Phase-by-Phase Implementation

### ✅ Phase 1-2: Completed
- OneDrive delta sync
- File record management
- Change detection
- Queue integration
- Document processing & classification

### 🔄 Phase 3: Next (Chunking & Embedding)
- Text chunking (500-token chunks, 50-token overlap)
- Generate embeddings (OpenAI text-embedding-3-small)
- Vector storage in Pinecone

### 📋 Phase 4: RAG Integration
- Use embeddings in semantic search
- Retrieve relevant chunks for chat context
- Build RAG chains with Claude

### 📊 Phase 5: Analytics
- Indexing statistics dashboard
- Failed document reports
- Performance metrics

## Troubleshooting

### Files stuck in "pending" status
1. Check Redis connection: `curl http://localhost:3000/api/indexing/queue/stats`
2. Check indexing worker logs
3. Reindex manually: `POST /api/indexing/files/:fileId/reindex`

### OneDrive sync failing
1. Verify accessToken is valid and not expired
2. Check OneDrive folder ID is correct
3. Verify Microsoft OAuth credentials in env

### Out of memory errors
- Reduce worker concurrency (default: 3)
- Increase available memory or split into smaller batches

### High costs
- Ensure only changed files are being re-indexed (check etag logic)
- Consider chunking larger documents differently
- Review classification truncation (2 pages per document)
