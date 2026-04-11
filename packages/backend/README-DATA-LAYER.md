# ProjectDashboard MVP Database Schema

## Overview

This document describes the database schema for the ProjectDashboard MVP (Minimum Viable Product). The schema is designed to support multi-tenant project management with AI-powered document processing and retrieval.

## Architecture

- **RDBMS**: PostgreSQL for relational data (organizations, users, projects, files, chat history)
- **Vector Store**: Pinecone or pgvector for semantic search (embeddings)
- **ORM**: Drizzle ORM for type-safe database operations
- **Migrations**: Drizzle Kit for schema version management

## Database Tables

### Organizations & Users

#### `organizations`
Multi-tenant organization table serving as the top-level entity.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key |
| `name` | TEXT | Organization name |
| `onedrive_tenant_id` | TEXT | Microsoft 365 tenant ID |
| `created_at` | TIMESTAMPTZ | Creation timestamp |

#### `users`
Users within organizations with role-based access.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key |
| `org_id` | UUID | Foreign key to organizations |
| `email` | TEXT | Unique email address |
| `name` | TEXT | User display name |
| `role` | TEXT | 'admin', 'pm', 'super', 'member' |
| `created_at` | TIMESTAMPTZ | Creation timestamp |

### Projects & Files

#### `projects`
Container for related documents and collaboration.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key |
| `org_id` | UUID | Foreign key to organizations |
| `name` | TEXT | Project name |
| `onedrive_folder_id` | TEXT | OneDrive root folder ID |
| `status` | TEXT | 'active', 'archived', 'deleted' |
| `created_at` | TIMESTAMPTZ | Creation timestamp |

#### `file_records`
**Core "memory object"** - stores metadata for every file with AI-generated insights.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key |
| `project_id` | UUID | Foreign key to projects |
| `onedrive_item_id` | TEXT | OneDrive unique item ID (indexed) |
| `file_name` | TEXT | Original file name |
| `file_path` | TEXT | Path within project folder |
| `file_type` | TEXT | 'pdf', 'docx', 'image', 'xlsx', etc. |
| `file_size` | BIGINT | Size in bytes |
| `mime_type` | TEXT | MIME type |
| **AI-Generated Metadata** | | |
| `summary` | TEXT | AI-generated summary (≤500 chars) |
| `key_topics` | TEXT[] | Extracted topics |
| `tags` | TEXT[] | Auto + manual tags |
| `doc_category` | TEXT | 'submittal', 'spec', 'drawing', 'rfi', 'photo', 'report' |
| `spec_section` | TEXT | CSI format e.g., '23 05 00' |
| `sheet_number` | TEXT | Drawing identifier e.g., 'A101' |
| `revision` | TEXT | Revision identifier e.g., 'Rev 3' |
| **Sync Metadata** | | |
| `onedrive_etag` | TEXT | Change detection ETag |
| `last_synced` | TIMESTAMPTZ | Last sync timestamp |
| `index_status` | TEXT | 'pending', 'processing', 'indexed', 'failed' |
| `last_indexed` | TIMESTAMPTZ | Last indexing timestamp |
| `chunk_count` | INTEGER | Number of vector chunks created |
| `created_at` | TIMESTAMPTZ | Creation timestamp |
| `updated_at` | TIMESTAMPTZ | Last update timestamp |

**Indexes**:
- `idx_file_records_project(project_id)` - efficient project file queries
- `idx_file_records_category(doc_category)` - filter by document type
- `idx_file_records_tags` (GIN) - full-text search on tags array
- `idx_file_records_spec(spec_section)` - CSI section lookup

### Chat & Conversations

#### `chat_sessions`
Container for a conversation thread.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key |
| `project_id` | UUID | Foreign key to projects |
| `user_id` | UUID | Foreign key to users |
| `created_at` | TIMESTAMPTZ | Creation timestamp |

#### `chat_messages`
Individual messages in a conversation with source references.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key |
| `session_id` | UUID | Foreign key to chat_sessions |
| `role` | TEXT | 'user' or 'assistant' |
| `content` | TEXT | Message content |
| `sources` | JSONB | [{file_id, file_name, chunk_id, relevance}] |
| `created_at` | TIMESTAMPTZ | Creation timestamp |

### Feature Registry

#### `features`
Pluggable feature definitions for dashboard icons and routes.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT | Unique feature ID ('onedrive', 'chat', etc.) |
| `name` | TEXT | Display name |
| `icon` | TEXT | Icon identifier |
| `route` | TEXT | Frontend route path |
| `enabled` | BOOLEAN | Feature enabled globally |
| `sort_order` | INTEGER | Dashboard display order |
| `config` | JSONB | Feature-specific settings |

#### `project_features`
Which features are enabled per project with custom config.

| Column | Type | Purpose |
|--------|------|---------|
| `project_id` | UUID | Foreign key to projects |
| `feature_id` | TEXT | Foreign key to features |
| `enabled` | BOOLEAN | Feature enabled for this project |
| `config` | JSONB | Project-specific feature config |

**Primary Key**: (project_id, feature_id)

### Vector Store & Chunks

#### `vector_chunks` (Metadata only)
Tracks which text chunks have been vectorized for semantic search.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID | Primary key |
| `file_id` | UUID | Foreign key to file_records |
| `chunk_index` | INTEGER | Chunk sequence number |
| `chunk_text` | TEXT | First 500 characters (preview) |
| `vector_id` | TEXT | Reference to Pinecone/pgvector ID |
| `token_count` | INTEGER | Approximate token count |
| `created_at` | TIMESTAMPTZ | Creation timestamp |

**Indexes**:
- `idx_vector_chunks_file(file_id)` - find chunks for a file
- `idx_vector_chunks_vector_id(vector_id)` - lookup by vector store ID

**Vector Store Schema** (Pinecone):
```
Namespace: {project_id}

Vector Record:
  id:        "{file_id}_{chunk_index}"
  values:    [1536-dim float array]  // OpenAI text-embedding-3-small
  metadata:
    file_id:       UUID
    file_name:     string
    chunk_index:   int
    chunk_text:    string (first 500 chars)
    doc_category:  string
    spec_section:  string
    sheet_number:  string
    tags:          string[]
```

## Key Design Patterns

### 1. Multi-Tenancy
- Every resource is scoped to an organization (`org_id`)
- Cascading deletes ensure data consistency
- Row-level security can be implemented at the application layer

### 2. File Memory Objects
- Each `file_record` acts as a "memory object" for documents
- Stores both original metadata (OneDrive sync info) and AI insights (summary, topics)
- Status tracking (`index_status`) enables robust processing pipelines

### 3. Document Classification
- `doc_category`: High-level classification (submittal, spec, drawing, etc.)
- `spec_section`: CSI MasterFormat section for spec documents
- `sheet_number`: Identifier for technical drawings (A101, etc.)
- `tags`: Flexible tagging system for project-specific organization

### 4. Chat Context Tracking
- `chat_messages.sources` stores JSONB array of referenced documents
- Enables RAG (Retrieval-Augmented Generation) implementations
- Supports answer traceability to original documents

### 5. Feature Extensibility
- `features` table allows dynamic dashboard features
- `project_features` junction table enables per-project feature configuration
- `config` JSONB columns store feature-specific settings

### 6. Semantic Search Foundation
- `vector_chunks` table bridges RDBMS and vector store
- Chunk metadata enables rich filtering and context in RAG pipelines
- Supports multi-model embeddings (text, image, etc. in future)

## Environment Configuration

Set these environment variables:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/contractor-ai
```

## Setup & Migrations

Generate and run migrations:

```bash
# Generate migrations from schema changes
npm run db:migrate

# Open Drizzle Studio for visual schema exploration
npm run db:studio

# Type-check the database layer
npm run type-check
```

## Query Patterns

See `src/db/queries.ts` for common query functions:

- **Organization**: Create, retrieve by ID
- **Users**: Create, find by ID/email, list by organization
- **Projects**: Create, retrieve, list by org, update status
- **Files**: Create, find, list by project/category, update metadata
- **Chat**: Create session/message, retrieve conversation history
- **Features**: List, enable/disable per project with custom config

## Future Enhancements

1. **Vector Search**: Implement pgvector for in-database embeddings
2. **Full-text Search**: Add PostgreSQL full-text search on file summaries
3. **Audit Trail**: Add audit_events table for compliance tracking
4. **Versioning**: Add file_versions table for document version history
5. **Permissions**: Implement project_members with granular role-based access
6. **Notifications**: Add notification_subscriptions for real-time updates
