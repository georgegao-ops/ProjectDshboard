# ContractorAI Project Roadmap (Web MVP)

## Executive Summary

The MVP delivers one high-value loop:

Connect OneDrive -> Sync and index documents -> Ask questions -> Get cited answers.

This is a focused web-based document intelligence tool for contractors. The product is not a general dashboard and avoids unnecessary features in favor of speed, clarity, and reliability.

## Product Principles

- Optimize for the first successful question, not breadth of features.
- Keep the system explainable: answers should always show sources.
- Design for operational clarity: every sync, indexing job, and chat request needs visible status.
- Prefer fewer moving parts in MVP even if the architecture is less flexible than the long-term vision.
- Ship one trustworthy workflow before expanding into adjacent modules.

## Scope Guardrails

### In scope

- Web app only
- Microsoft authentication
- OneDrive connection and project folder selection
- Manual sync
- PDF and DOCX support
- Indexed file inventory
- Grounded chat with citations

### Out of scope for MVP

- Mobile apps
- Push notifications
- OCR-heavy document support unless pilot data forces it
- Background sync scheduling and webhooks
- Daily reports, photos, timesheets, and other adjacent modules
- Advanced role systems beyond basic admin/member needs
- DWG or CAD parsing

## Architecture Overview

### Frontend (Web)

- Next.js App Router
- Handles authentication UI, onboarding, project views, files UI, and chat interface

### Backend (API and Core Logic)

- Express server
- Handles authentication, OneDrive integration, sync orchestration, indexing pipeline, retrieval, and chat
- Owns the authoritative auth and session flow to avoid split logic between frontend and backend

### Database

- Postgres with pgvector
- Stores users, projects, file metadata, embeddings, and chat history

### Queue System

- BullMQ with Redis
- Handles indexing jobs, retries, dead-letter behavior, and failure recovery

### Shared Package

- Contains types, API contracts, validation helpers, and client helpers
- Should not contain business logic or heavy shared state for the web MVP

## Delivery Strategy

Build as a sequence of vertical slices. Each phase should leave the repository in a working state with focused validation passing before the next phase begins.

## Phase 0 - Foundation and Observability

### Goals

- Stabilize the repository
- Establish clear architecture boundaries
- Make the system debuggable

### Tasks

- Fix shared package imports and type issues
- Ensure root type-check passes
- Ensure root test command runs
- Clean up inconsistent naming and schema mismatches
- Standardize environment variable structure
- Document local development setup and required services

### Service Architecture

- Create service layer structure:
  - `auth.service`
  - `onedrive.service`
  - `project.service`
  - `sync.service`
  - `indexing.service`
  - `retrieval.service`
  - `chat.service`

### Logging and Observability

- Add request logging
- Add job-level logging for indexing
- Add structured error handling
- Add health endpoints for API, database, and queue connectivity

### Queue Design

- Define retry strategy
- Define dead-letter queue behavior
- Define idempotency keys for jobs
- Define concurrency limits for indexing workers

### Exit Criteria

- Repo builds cleanly
- Root type-check passes
- Root tests run cleanly or have explicitly documented exceptions
- Logging exists for core flows
- Services are clearly separated

## Phase 1 - Authentication

### Goals

- Replace demo auth with real Microsoft authentication

### Tasks

- Implement Microsoft OAuth flow in backend
- Implement callback handling
- Issue and persist sessions
- Implement token refresh handling where applicable
- Create `/api/auth/me` endpoint
- Add auth guards for protected routes
- Replace demo login UI
- Remove demo credentials and demo-only route behavior

### Engineering Decisions

- Backend owns OAuth exchange and session issuance
- Web app consumes backend auth endpoints instead of duplicating auth logic
- Prefer secure HTTP-only session cookies over browser-managed token persistence for the web app

### Product Notes

- Login flow should be short and predictable
- If authentication fails, the error state must tell the user what to do next

### Exit Criteria

- Users can sign in and remain authenticated
- Sessions persist reliably across refreshes
- Authenticated users land in the correct onboarding or project flow

### Phase 1 Implementation Notes

- Auth is now backend-owned and web sessions are stored in an HTTP-only `app_session` cookie.
- The web app rehydrates auth through `GET /api/auth/me`; logout clears the cookie and revokes the backend session.
- Backend session storage supports a Postgres-backed `auth_sessions` path, with in-memory fallback only for tests or no-database contexts.

### Phase 1 Future-Phase Notes

- Apply `packages/backend/drizzle/0000_deep_spot.sql` before relying on durable sessions. It is currently a bootstrap/full-schema migration because the repo had no earlier Drizzle migration history.
- Phase 2 should reuse the existing authenticated app user context for OneDrive and project setup rather than introducing a second session or identity model.
- Post-login routing is still a placeholder and should be finalized alongside onboarding/project selection work in Phase 2.

### Phase 2 Implementation Notes

- OneDrive OAuth is now wired end-to-end through backend-owned connect start/callback exchange (`/api/onedrive/connect/start` and `/api/onedrive/connect`) with web proxy routes.
- OneDrive folder browsing is backed by Microsoft Graph (`/api/onedrive/browse`) and supports root/up navigation and explicit folder selection before project creation.
- OneDrive connection data (tenant/account/drive metadata and refresh token) now persists in `onedrive_connections` with in-memory fallback for test/no-database contexts.

### Phase 2 Pre-Phase-3 Checklist

- Apply `packages/backend/drizzle/0001_onedrive_connections.sql` so OneDrive connections survive backend restarts in local/staging environments.
- Keep `ONEDRIVE_API_ENDPOINT` pointed at Microsoft Graph v1.0 unless a tenant-specific override is required.
- Confirm OneDrive status displays account and tenant metadata after reconnect to validate durable token path before sync implementation.

### Phase 2 Learnings Needed For Phase 3

- OAuth callback reliability depends on exact redirect URI matching per flow (`/auth/callback` and `/onedrive/callback` must both be registered exactly, including protocol, host, port, and path).
- Microsoft SSO can auto-select an existing signed-in account; this is expected behavior and should not be treated as a sync regression by itself.
- OneDrive browse-only success is not sufficient validation for sync readiness; Phase 3 needs explicit callback failure visibility and server-side logging around token exchange and Graph API calls.
- Route tests can pass while local OAuth runtime still fails due to environment drift. Keep a runtime probe in the Phase 3 debug workflow: backend health endpoint plus auth/connect redirect verification.
- Durable OneDrive token storage must be verified before sync work; otherwise file inventory can appear to work in-memory but fail after backend restarts.

## Phase 2 - OneDrive Connection and Project Setup

### Goals

- Allow users to connect OneDrive and create projects

### Tasks

- Implement OneDrive OAuth connection
- Store access and refresh tokens securely
- Implement token refresh logic
- Add tenant and account validation checks where needed

### OneDrive Service

- Build abstraction layer for Microsoft Graph:
  - Folder browsing
  - File listing
  - File download metadata access

### Project Setup

- Build project creation flow
- Allow folder selection
- Store `onedriveFolderId`
- Persist project data
- Associate project ownership and organization membership

### UX Improvements

- Simplify folder navigation
- Show recent or commonly used folders if Graph data allows it
- Reduce user confusion about which folder should be selected

### Validation

- Test onboarding flow with real users or representative pilot accounts

### Exit Criteria

- Users can connect OneDrive
- Users can select a folder and create a project
- Projects are persisted and reload correctly

## Phase 3 - Sync and File Inventory

### Goals

- Sync file metadata and display project file inventory

### Tasks

### File Model

- Define file record fields:
  - `fileId`
  - `name`
  - `hash`
  - `lastSyncedAt`
  - `status`
  - `mimeType`
  - `size`

### Sync Logic

- Implement manual sync trigger
- Implement recursive folder traversal or delta query, whichever is simpler and reliable first
- Handle pagination and rate limits
- Detect new, updated, and deleted files
- Upsert file records in database
- Track sync run summaries and errors

### Constraints

- Define maximum file size
- Restrict supported file types to PDF and DOCX for MVP
- Mark unsupported files explicitly instead of failing silently

### UI

- Build file list view
- Add filtering and pagination
- Display sync status and timestamps
- Show last sync outcome, not just whether sync started

### Product Notes

- Users should understand whether the system is ready to answer questions
- Sync progress should feel trustworthy even if indexing is still running

### Exit Criteria

- File inventory is accurate
- Sync updates reflect correctly in UI
- Unsupported or failed files are visible to the user

### Phase 3 Kickoff Notes (Started April 15, 2026)

- Implemented recursive OneDrive metadata traversal in backend service layer for project folder sync.
- Implemented manual sync metadata flow that:
  - scans files recursively,
  - classifies supported vs unsupported files (PDF/DOCX supported for MVP),
  - persists file inventory in service memory for current runtime,
  - returns sync summary counts needed by UI.
- Wired backend `GET /api/projects/:id/files` to return real paginated inventory data with search/category/tag filters.
- Added web proxy routes for:
  - `POST /api/onedrive/sync`
  - `GET /api/projects/:id/files`
- Added/updated tests validating end-to-end sync summary and file inventory route behavior.

### Phase 3 Immediate Next Steps

- [Completed] Persist sync file inventory and sync run summaries in Postgres with in-memory fallback.
- [Completed] Add first file inventory UI panel with manual sync trigger, sync summary, and unsupported-file visibility.
- [Completed] Add delta-aware file persistence (preserve unchanged file indexing state by etag).
- [In progress] Emit structured sync run logs and user-facing error states for Graph pagination/rate-limit failures.

### Phase 3 Next Technical Tasks

- Persist OneDrive file traversal cursors or delta tokens to reduce full recursive scans for large folders.
- Add sync failure analytics and retry telemetry by sync run id.
- Add file inventory pagination controls and filters in web UI (status, unsupported, search).

## Phase 4 - Indexing Pipeline

### Goals

- Extract, process, and store searchable document content

### Tasks

### Pipeline Steps

1. Download files using streaming
2. Extract text from PDF and DOCX
3. Clean and normalize extracted text
4. Chunk text with overlap
5. Generate embeddings in batches
6. Store embeddings in database

### Indexing Design

- Define chunk size and overlap strategy
- Track chunk counts per file
- Record extraction quality and failure reasons where feasible

### Idempotency

- Use file hash or equivalent version marker to prevent duplicate indexing
- Skip unchanged files

### Failure Handling

- Implement retry logic
- Implement dead-letter queue
- Track failure states
- Provide a manual retry path for failed files

### Status Tracking

- Track file indexing states:
  - `pending`
  - `processing`
  - `indexed`
  - `failed`

### UI

- Show indexing progress
- Show failure states
- Distinguish sync completion from indexing completion

### Exit Criteria

- Files are reliably indexed
- Failures are visible and recoverable
- Unchanged files are not reprocessed unnecessarily

## Phase 4.5 - Retrieval Quality

### Goals

- Ensure search and answers are relevant and useful before broad pilot rollout

### Tasks

- Tune chunk size and overlap
- Tune top-k retrieval values
- Implement metadata filtering
- Add basic ranking improvements
- Create a small evaluation set of representative contractor questions

### Validation

- Test real user queries
- Evaluate answer quality and citations
- Compare retrieval quality across a few document types

### Exit Criteria

- Answers are relevant, grounded, and correctly cited
- Retrieval quality is acceptable on a repeatable evaluation set, not just ad hoc demos

## Phase 5 - Chat System

### Goals

- Enable natural language querying with grounded responses

### Tasks

### Chat Infrastructure

- Implement chat sessions
- Persist messages
- Support response streaming to the frontend

### Retrieval Pipeline

- Implement:
  - metadata filtering
  - vector search
  - ranking
  - context assembly

### LLM Integration

- Generate responses using retrieved context
- Stream responses to frontend
- Enforce source-grounded prompting
- Return citations and source links with every successful answer

### UI

- Build chat interface
- Display citations and source links
- Highlight referenced content where feasible
- Handle empty, loading, and failure states clearly

### Product Notes

- The assistant must say it does not know when context is insufficient
- Citation UX matters as much as answer fluency

### Exit Criteria

- Users can ask questions and receive cited answers
- Chat history persists
- The system avoids uncited answers in normal operation

## Phase 6 - Web Product Shell

### Goals

- Replace generic dashboard with focused product UI

### Tasks

- Build project-centric layout
- Add navigation:
  - Overview
  - Files
  - Chat
  - Settings
- Display:
  - sync status
  - indexed file count
  - failed jobs
  - last successful sync

### UX Principle

- Users should be able to understand readiness and ask a question immediately after login or project selection

### Product Notes

- Overview should answer three things quickly:
  - Is my project connected?
  - How much is indexed?
  - Can I trust the chat yet?

### Exit Criteria

- UI reflects actual product functionality
- No placeholder or demo UI remains
- First-time users can complete onboarding without operator help

## Validation Strategy

### For Each Phase

- Keep type-check passing
- Add targeted tests for core logic
- Validate end-to-end functionality
- Capture known gaps before moving to the next phase

### Key Integration Tests

- Authentication flow
- Project creation
- Sync trigger
- Indexing pipeline
- Chat query flow

### Pilot Readiness Checks

- Can a new account complete onboarding without internal knowledge?
- Can the system recover from partial sync or indexing failure?
- Are source citations present on answers users would act on?

## Success Metrics

### System Metrics

- Percentage of files successfully indexed
- Indexing failure rate
- Sync completion rate
- Median and p95 indexing job duration

### Product Metrics

- Response latency
- Percentage of responses with citations
- Percentage of questions answered from indexed context without failure

### User Metrics

- Queries per session
- Repeat usage
- Time from sign-in to first successful cited answer

### Suggested MVP Targets

- First project setup completed in under 15 minutes
- Majority of supported files indexed successfully on first pass
- Median cited response time under 5 seconds after retrieval is warmed

## Risks and Mitigation

### External Dependencies

- Microsoft Graph API reliability
- File format inconsistencies
- LLM or embedding provider latency and rate limits

### Technical Risks

- Indexing failures
- Large file handling
- Retrieval quality degrading on noisy construction documents

### Product Risks

- Poor answer quality
- Users not trusting the system when indexing state is unclear
- Onboarding friction around folder selection

### Mitigation

- Retry and backoff strategies
- File size and file type limits
- Retrieval tuning phase before broader rollout
- Clear status UI and failure messaging
- Use a pilot dataset early rather than waiting for late-stage validation

## Release Approach

### Internal Readiness

- Use a seeded internal project to validate the complete workflow end to end
- Keep staging environment close to production dependencies

### Pilot Rollout

- Start with a small set of pilot users
- Limit the number of active projects during the first rollout
- Collect examples of failed answers and missed citations as product feedback inputs

## Definition of MVP Done

The MVP is complete when:

- A user signs in with Microsoft
- A user connects OneDrive and selects a folder
- Files are synced and indexed
- A user can ask questions about documents
- The system returns grounded answers with citations
- The UI provides clear status and error visibility
- Pilot users can complete the workflow without operator intervention
