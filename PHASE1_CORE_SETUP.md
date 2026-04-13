# ContractorAI MVP — Phase 1: Foundation & Core Loop

## What's Implemented (feature/mvp-core)

This branch implements the **foundational infrastructure** for the ContractorAI MVP. The system is ready for:
- ✅ Multi-tenant architecture (organizations, users, projects)
- ✅ Monorepo structure (shared types, API client, state management)
- ✅ Database schema with Drizzle ORM
- ✅ Microsoft OAuth2 skeleton
- ✅ Feature registry & pluggable dashboard system
- ✅ Express backend with route stubs
- ✅ Zustand state management across platforms

## Architecture

```
contractor-ai/
├── apps/
│   ├── mobile/           ← Expo (iOS + Android)
│   └── web/              ← Next.js
├── packages/
│   ├── shared/           ← Types, API client, stores
│   └── backend/          ← Node.js + Express
```

### Shared Package (`@contractor/shared`)
The heart of the monorepo. Used by web, mobile, and backend:

- **types/entities.ts** — All entity types (Organization, User, Project, FileRecord, etc.)
- **types/api.ts** — API request/response contracts
- **api/client.ts** — Typed API client (fetch wrapper)
- **state/** — Zustand stores (auth, projects, chat, files, features)
- **features/registry.ts** — Pluggable dashboard feature system

### Backend (`@contractor/backend`)

Core Express server:

- **db/schema.ts** — Drizzle ORM PostgreSQL schema
- **db/index.ts** — Database initialization
- **auth/oauth.ts** — Microsoft OAuth2 helpers
- **server.ts** — Express app with route stubs

## Getting Started

### 1. Prerequisites

- **Node.js** 18+ (use nvm or similar)
- **PostgreSQL** 14+ (or Docker)
- **Visual Studio Code** with TypeScript support

### 2. Install Dependencies

```bash
npm install
```

This installs all workspace packages and their dependencies.

### 3. Environment Setup

Copy and fill in environment variables:

```bash
cp .env.example .env
```

Key variables for Phase 1:

```env
# Database (local development)
DATABASE_URL=postgresql://postgres:password@localhost:5432/contractor_ai

# Microsoft OAuth (get from https://portal.azure.com/)
MICROSOFT_CLIENT_ID=xxx
MICROSOFT_CLIENT_SECRET=xxx
OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback

# Backend
NODE_ENV=development
PORT=3001
```

### 4. PostgreSQL Setup

**Option A: Local PostgreSQL**

```bash
# macOS with Homebrew
brew install postgresql
brew services start postgresql

# Windows (download installer or WSL)
# Linux: apt-get install postgresql
```

**Option B: Docker**

```bash
docker run --name contractor-ai-db \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=contractor_ai \
  -p 5432:5432 \
  -d postgres:15
```

### 5. Database Migrations

Generate and run initial migrations:

```bash
# Generate migration from schema
npm run db:migrate

# Or use Drizzle Studio (web UI for database)
npm run db:studio
```

### 6. Start Development Servers

In separate terminals:

**Backend:**
```bash
cd packages/backend
npm run dev
# → http://localhost:3001
```

**Web Frontend:**
```bash
cd apps/web
npm run dev
# → http://localhost:3000
```

**Mobile (Expo):**
```bash
cd apps/mobile
npm run dev
# Choose 'i' for iOS or 'a' for Android
```

## API Endpoints (Phase 1 — Stubs)

### Auth
- `POST /api/auth/login` — OAuth2 login
- `POST /api/auth/refresh` — Refresh token
- `GET /api/auth/me` — Current user + organization

### OneDrive
- `POST /api/onedrive/connect` — Connect OneDrive
- `GET /api/onedrive/status` — Sync status
- `POST /api/onedrive/sync` — Trigger sync
- `GET /api/onedrive/browse` — Browse folders/files

### Projects
- `GET /api/projects` — List projects
- `POST /api/projects` — Create project
- `GET /api/projects/:id` — Project details
- `GET /api/projects/:id/files` — Indexed files (paginated)

### Chat
- `POST /api/chat/sessions` — Create chat session
- `POST /api/chat/sessions/:id/message` — Send message (stub echoes back)
- `GET /api/chat/sessions/:id/messages` — Chat history

### Features (Dashboard)
- `GET /api/features/registry` — All available features
- `GET /api/projects/:id/features` — Enabled features
- `PUT /api/projects/:id/features/:id` — Enable/configure feature

## Database Schema

PostgreSQL tables (created via Drizzle migrations):

- `organizations` — Multi-tenant containers
- `users` — Team members (admin, pm, member, super)
- `projects` — OneDrive folder links
- `file_records` — Indexed documents ("memory objects")
  - Includes AI classification (category, tags, spec section, sheet number, revision)
  - Sync metadata (etag, index status, chunk count)
- `chat_sessions` — Conversation threads
- `chat_messages` — Messages with source citations
- `features` — Dashboard plugin registry
- `project_features` — Feature enablement per project

Indexes for fast queries:
- `file_records(project_id)`
- `file_records(doc_category)` and `file_records(tags)`
- `file_records(spec_section)` — for spec-based searches
- `chat_sessions(project_id, user_id)`
- `chat_messages(session_id)`

## Directory Structure

```
packages/shared/src/
├── types/
│   ├── entities.ts      # User, Project, FileRecord, etc.
│   └── api.ts           # Request/response contracts
├── api/
│   └── client.ts        # Typed API client
├── state/
│   ├── authStore.ts
│   ├── projectsStore.ts
│   ├── chatStore.ts
│   ├── filesStore.ts
│   └── featuresStore.ts
├── features/
│   └── registry.ts      # Pluggable feature system
└── index.ts             # Main exports

packages/backend/src/
├── db/
│   ├── schema.ts        # Drizzle ORM PostgreSQL schema
│   └── index.ts         # DB initialization
├── auth/
│   └── oauth.ts         # Microsoft OAuth2 helpers
├── server.ts            # Express app + routes (stubs)
└── middleware/          # (to be added in Phase 2)

apps/web/
├── app/                 # Next.js App Router
├── components/
├── public/
└── app.config.ts

apps/mobile/
├── app/                 # Expo Router (file-based routing)
├── components/
├── assets/
└── app.config.ts        # Expo configuration
```

## Pluggable Dashboard Feature System

The MVP ships with **two core features** (OneDrive, Chat), but is architected for easy expansion:

### Built-in Features

```typescript
BUILTIN_FEATURES = {
  onedrive: {
    id: "onedrive",
    name: "OneDrive",
    icon: "cloud",
    route: "/project/:id/onedrive",
    platforms: ["ios", "android", "web"],
    defaultEnabled: true,
  },
  chat: {
    id: "chat",
    name: "Chat",
    icon: "message-square",
    route: "/project/:id/chat",
    platforms: ["ios", "android", "web"],
    defaultEnabled: true,
  },
};
```

### Adding a New Feature (Example: Daily Photos)

1. Create feature module:
   ```typescript
   // features/daily-photos/index.ts
   export const dailyPhotosFeature: FeatureModule = {
     id: "daily_photos",
     name: "Daily Photos",
     icon: "camera",
     route: "/project/:id/photos",
     // ... etc
   };
   ```

2. Register in backend:
   ```typescript
   featureRegistry.register(dailyPhotosFeature);
   ```

3. Add UI components (platform-specific):
   - `apps/web/components/features/PhotosView.tsx`
   - `apps/mobile/components/features/PhotosView.tsx`

4. Enable for project:
   ```sql
   INSERT INTO project_features (project_id, feature_id, enabled)
   VALUES ('<project-id>', 'daily_photos', true);
   ```

Dashboard automatically renders the new icon!

## Next Steps (Phase 1.2-1.3)

1. **Implement OAuth2 Flow**
   - Exchange authorization code for tokens (backend)
   - Create/get user from token claims
   - Sign JWT for API endpoints

2. **Implement OneDrive Integration**
   - OAuth2 for OneDrive scopes
   - Delta sync endpoint (polling)
   - Queue file indexing jobs

3. **Error Handling & Validation**
   - Request validation (Zod)
   - Proper HTTP error responses
   - Logging

4. **Testing**
   - Unit tests for API client
   - Integration tests for routes
   - E2E tests (web + mobile)

## Debugging

### View Database Schema

```bash
npm run db:studio
# Opens web UI at http://localhost:5555
```

### TypeScript Type Checking

```bash
npm run type-check
# or with watch
npm run type-check -- --watch
```

### Lint

```bash
npm run lint
```

### Common Issues

**"Database not initialized"**
- Ensure `DATABASE_URL` is set in `.env`
- Check PostgreSQL is running (`psql -U postgres`)

**"OAuth config missing"**
- Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in `.env`
- Register redirect URI in Azure AD app

**"Port 3001 already in use"**
- Change `PORT` in `.env` or kill process: `lsof -i :3001`

## Contributing

- Keep changes scoped to the MVP plan
- Update types in `@contractor/shared` first
- Add API routes to backend stubs
- Test across web and mobile

## Resources

- [Drizzle ORM Docs](https://orm.drizzle.team/)
- [Zustand Docs](https://github.com/pmndrs/zustand)
- [Express.js Guide](https://expressjs.com/)
- [Expo Docs](https://docs.expo.dev/)
- [Next.js Docs](https://nextjs.org/docs)
- [Microsoft Graph API](https://learn.microsoft.com/en-us/graph/api/overview)
- [Turborepo Docs](https://turbo.build/)

---

**Phase Goal:** Have all routes responding (even if with stubs) and local dev environment working.
**Success Metric:** Run `npm run dev` and all three servers start cleanly.
