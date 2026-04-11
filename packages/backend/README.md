# Backend Services

Express server providing REST API for the Contractor Dashboard.

## Architecture

```
Backend (Node.js + Express)
├── Auth Service - User authentication and authorization
├── Project Service - Project management and tracking
├── Task Service - Task creation and management
├── Chat Service - Real-time chat and notifications
├── OneDrive Sync - Document synchronization
└── Push Notifications - Browser/mobile push alerts
```

## Services

### Auth Service (`src/services/authService.ts`)
- JWT token generation and verification
- Password hashing and validation
- Session management

### API Routes

#### Authentication (`/api/auth`)
- `POST /login` - User login
- `POST /signup` - User registration
- `POST /logout` - User logout
- `POST /refresh` - Token refresh

#### Projects (`/api/projects`)
- `GET /` - List all projects
- `GET /:id` - Get project details
- `POST /` - Create new project
- `PATCH /:id` - Update project
- `DELETE /:id` - Delete project

#### Tasks (`/api/tasks`)
- `GET /` - List all tasks
- `GET /:id` - Get task details
- `POST /` - Create new task
- `PATCH /:id` - Update task
- `DELETE /:id` - Delete task

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   Copy `.env.backend` to `.env` and configure:
   ```bash
   cp .env.backend .env
   ```

3. **Run development server**
   ```bash
   npm run dev
   ```

4. **Build for production**
   ```bash
   npm run build
   npm start
   ```

## Database Migrations

Migrations are managed with Drizzle ORM:

```bash
# Run migrations
npm run db:migrate

# Open DB studio
npm run db:studio
```

## Background Jobs

The server uses Bull (bullmq) for background job processing:

- **Chat Queue** - Process chat messages and notifications
- **Sync Queue** - Handle OneDrive document synchronization
- **Email Queue** - Send transactional emails

Access job status through Redis client.

## API Response Format

All responses follow this format:

```json
{
  "success": true,
  "data": {},
  "message": "Optional message"
}
```

Error responses:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error description"
  }
}
```

## Environment Variables

See `.env.backend` for all available configuration options.

Critical ones:
- `PORT` - Server port
- `JWT_SECRET` - Secret for JWT tokens
- `REDIS_HOST` / `REDIS_PORT` - Redis cache
- `DB_*` - PostgreSQL connection details
