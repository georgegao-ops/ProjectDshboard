# ContractorAI — MVP

A construction document management and AI chat platform for contractors. The current MVP focus is the web workflow: connect OneDrive, sync documents, and ask grounded questions with citations.

## What's In The Box

- **Mobile** (iOS + Android): React Native via Expo
- **Web**: Next.js 14 with App Router
- **Shared Logic**: TypeScript packages for API client, hooks, types, and state
- **Backend**: Node.js + Express, PostgreSQL, Pinecone vectors, Redis queue
- **Indexing**: OneDrive → document extraction → LLM classification → embeddings → RAG chat

## Project Structure

```
contractor-ai/
├── apps/
│   ├── mobile/              # Expo app (iOS + Android)
│   │   ├── app/             # Expo Router screens
│   │   ├── components/      # React Native components
│   │   ├── app.json         # Expo config
│   │   └── eas.json         # EAS Build config
│   │
│   └── web/                 # Next.js web app
│       ├── app/             # Next.js App Router
│       ├── components/      # Web components
│       └── next.config.js
│
├── packages/
│   ├── shared/              # Shared across all platforms
│   │   ├── src/
│   │   │   ├── api/         # API client
│   │   │   ├── hooks/       # React hooks
│   │   │   ├── types/       # TypeScript types
│   │   │   ├── state/       # Zustand stores
│   │   │   ├── utils/       # Validation, formatting, constants
│   │   │   └── features/    # Feature registry
│   │   └── package.json
│   │
│   ├── backend/             # Node.js express server
│   │   ├── src/
│   │   │   ├── auth/        # OAuth, tokens
│   │   │   ├── onedrive/    # OneDrive integration
│   │   │   ├── projects/    # Project CRUD
│   │   │   ├── chat/        # Chat & RAG
│   │   │   ├── indexing/    # Queue workers
│   │   │   ├── db/          # Database setup
│   │   │   └── server.ts    # Express entry
│   │   ├── migrations/      # Drizzle migrations
│   │   └── package.json
│   │
│   └── cli/                 # Command-line utilities (future)
│
├── turbo.json               # Turborepo config
├── tsconfig.json            # Shared TypeScript config
├── package.json             # Workspace root
└── README.md                # This file
```

## Stack

| Layer | Tech | Why |
|-------|------|-----|
| **Mobile** | Expo SDK 52 + React Native | Single codebase → App Store + Play Store |
| **Web** | Next.js 14 + App Router | SSR, fast builds, Vercel deploy |
| **Shared** | TypeScript + Zustand | Type safety, shared logic |
| **Backend** | Node.js + Express | Same language, good integrations |
| **Auth** | Microsoft OAuth2 (MSAL) | Contractors already have M365 |
| **Database** | PostgreSQL | Relational + JSONB for metadata |
| **Vectors** | Pinecone | Simple vector search at scale |
| **Queue** | Redis + BullMQ | Reliable document indexing pipeline |
| **Chat** | Claude Sonnet | Strong document comprehension |
| **Classification** | Claude Haiku | Fast + cheap tagging |

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 10+
- PostgreSQL 14+
- Redis 7+

### Installation

```bash
# Clone the repo
git clone https://github.com/georgegao-ops/ProjectDshboard.git contractor-ai-mvp
cd contractor-ai-mvp

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env

# Start the web app and backend in separate terminals
pnpm -F @contractor/backend dev
pnpm -F @contractor/web dev
```

### Required Local Services

- PostgreSQL for the backend database (`DATABASE_URL`)
- Redis for queue connectivity and health checks (`REDIS_URL`)

### Environment Variables

The repository uses a single `.env` file in local development. Phase 0 standardizes these variables:

```env
# Runtime
NODE_ENV=development
PORT=3001
API_BASE_URL=http://localhost:3001

# Backend dependencies
DATABASE_URL=postgresql://user:password@localhost:5432/contractor_ai
REDIS_URL=redis://localhost:6379

# Microsoft OAuth
MICROSOFT_CLIENT_ID=your-client-id-here
MICROSOFT_CLIENT_SECRET=your-client-secret-here
OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback

# Frontend
NEXT_PUBLIC_API_URL=http://localhost:3001
EXPO_PUBLIC_API_BASE_URL=http://localhost:3001
```

### Local Microsoft OAuth Setup (Required For Login)

If login shows "Microsoft OAuth is not configured", your backend is running but `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are empty.

1. Create or open an app registration in Azure Portal.
2. Add a Web redirect URI:
	- `http://localhost:3000/auth/callback`
	- `http://localhost:3000/onedrive/callback`
3. Ensure delegated Microsoft Graph permissions include:
	- `openid`
	- `profile`
	- `email`
	- `offline_access`
	- `Files.Read`
4. Copy values into root `.env`:

```env
MICROSOFT_CLIENT_ID=<your-app-client-id>
MICROSOFT_CLIENT_SECRET=<your-app-client-secret>
OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback
```

Important:
- OneDrive connect uses `http://localhost:3000/onedrive/callback`.
- Microsoft requires an exact redirect URI match per OAuth request.
- If login works but OneDrive connect fails with `invalid_request` for `redirect_uri`, the OneDrive callback URI is missing in the app registration.

5. Restart backend after changing `.env`:

```bash
pnpm -F @contractor/backend dev
```

6. Verify auth start returns a redirect (expected status: 302):

```bash
node -e "(async()=>{const r=await fetch('http://localhost:3001/api/auth/login?redirectUri='+encodeURIComponent('http://localhost:3000/auth/callback'),{redirect:'manual'}); console.log('status='+r.status); console.log('location='+(r.headers.get('location')||''));})();"
```

Expected result:
- `status=302`
- `location` contains `login.microsoftonline.com`

If you still see `status=503` with `oauth_not_configured`, the backend process has not loaded valid OAuth credentials yet.

### Health Endpoints

- `GET /health` returns overall API, database, and queue status
- `GET /health/api` returns process-level health
- `GET /health/db` validates database connectivity
- `GET /health/queue` validates Redis connectivity when configured

## MVP Timeline

**14 weeks** to iOS + Android + Web with:

- OneDrive document sync & indexing
- AI chat with source citations
- Pluggable dashboard architecture
- Push notifications (mobile)
- App Store & Play Store ready

See the full plan: [Contractor MVP Plan](./CONTRACTOR_MVP_PLAN.md) (coming soon)

## Key Features (MVP)

✅ **OneDrive Integration**
- Connect & authorize OneDrive
- Delta sync for new/changed files
- Smart folder browser (mobile + web)

✅ **Document Indexing**
- Auto-extract text from PDFs, DOCX, images
- LLM-powered classification (category, spec section, tags, summary)
- Chunking + embedding → Pinecone

✅ **AI Chat with RAG**
- Hybrid search (metadata filters + vector similarity)
- Source citations with file links
- Stream responses in real-time

✅ **Native Mobile**
- iOS app via TestFlight
- Android app via Play Store beta
- Voice input for dirty hands
- Native components, not a web wrapper

✅ **Dashboard**
- Pluggable feature system
- Easy to add new icons (photos, reports, timesheets)
- Works on all platforms

## Development Workflow

### Running Tasks with Turbo

```bash
# Build all packages
pnpm build

# Run type checking everywhere
pnpm type-check

# Run linting
pnpm lint

# Run tests
pnpm test

# Filter to specific workspace
pnpm -F @contractor/shared build
```

### Making Changes

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Run tests: `pnpm test`
4. Create a PR to `main`
5. Merge after review

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) (coming soon)

## License

MIT

## Status

🔨 **MVP In Development**

- Phase 1 (Weeks 1-2): Monorepo + Auth ← Current
- Phase 2-3 (Weeks 3-4): OneDrive sync
- Phase 4-7 (Weeks 5-7): Indexing pipeline
- Phase 8-9 (Weeks 8-9): Chat system
- Phase 10-12 (Weeks 10-12): Polish
- Phase 13-14 (Weeks 13-14): Testing + App Store

---

**For the full MVP plan, see the attached PDF or run:**

```bash
cat CONTRACTOR_MVP_PLAN.md
```
