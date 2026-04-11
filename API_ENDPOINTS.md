# ProjectDashboard API Endpoints (MVP)

## Overview
This document outlines all the API endpoints for the ProjectDashboard MVP. The API follows RESTful conventions and returns JSON responses.

## Base URL
```
http://localhost:3000/api
```

## Response Format
All responses follow this format:
```json
{
  "success": true,
  "data": { ... }
}
```

For errors:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error description"
  }
}
```

---

## Authentication

### POST `/auth/login`
Authenticate user with email and password.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "token": "base64-encoded-token",
    "user": {
      "id": "user-123",
      "name": "John Doe",
      "email": "user@example.com",
      "role": "manager"
    }
  }
}
```

### POST `/auth/signup`
Register a new user.

**Request:**
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "password123"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "user": { ... },
    "token": "..."
  }
}
```

### POST `/auth/refresh`
Refresh authentication token.

**Request:**
```json
{
  "refreshToken": "refresh-token-value"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "new-access-token"
  }
}
```

### GET `/auth/me`
Get current user and organization info.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "user-123",
    "name": "John Doe",
    "email": "user@example.com",
    "role": "manager",
    "organization": {
      "id": "org-123",
      "name": "Acme Construction",
      "role": "owner"
    }
  }
}
```

### POST `/auth/logout`
Logout user (invalidate token).

**Response (200):**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

## OneDrive Integration

### POST `/onedrive/connect`
Initiate OAuth flow and store tokens.

**Request:**
```json
{
  "authCode": "authorization-code-from-microsoft"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "connected": true,
    "message": "OneDrive connected successfully"
  }
}
```

### GET `/onedrive/status`
Get OneDrive connection and sync status.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "connected": true,
    "lastSyncedAt": "2024-01-20T10:30:00Z",
    "nextSyncAt": "2024-01-20T11:30:00Z",
    "syncStatus": "idle",
    "lastErrorMessage": null
  }
}
```

### POST `/onedrive/sync`
Trigger manual sync of OneDrive folder.

**Request:**
```json
{
  "folderId": "onedrive-folder-id"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "syncId": "sync-1234567890"
  }
}
```

### GET `/onedrive/browse`
Browse OneDrive folders and files.

**Query Parameters:**
- `folderId` (optional): Folder ID to browse (default: "root")

**Response (200):**
```json
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "file-id-123",
        "name": "Floor Plan.pdf",
        "type": "file",
        "path": "/Documents/Projects/",
        "size": 2048000,
        "modifiedAt": "2024-01-20T10:30:00Z"
      },
      {
        "id": "folder-id-456",
        "name": "Specifications",
        "type": "folder",
        "path": "/Documents/",
        "modifiedAt": "2024-01-19T14:15:00Z"
      }
    ],
    "folderId": "root"
  }
}
```

---

## Projects

### GET `/projects`
List all projects for the authenticated user's organization.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20)
- `status` (optional): Filter by status (planning, active, completed)

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "project-1",
      "name": "Building A - Phase 2",
      "description": "Commercial building project",
      "status": "active",
      "progress": 65,
      "startDate": "2024-01-15",
      "endDate": "2025-06-30",
      "budget": 500000,
      "spent": 325000
    }
  ]
}
```

### POST `/projects`
Create a new project and optionally link OneDrive folder.

**Request:**
```json
{
  "name": "New Project",
  "description": "Project description",
  "budget": 100000,
  "endDate": "2025-12-31",
  "oneDriveFolderId": "folder-id-optional"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "new-project-id",
    "name": "New Project",
    "description": "Project description",
    "status": "planning",
    "progress": 0,
    "startDate": "2024-01-20",
    "endDate": "2025-12-31",
    "budget": 100000,
    "spent": 0
  }
}
```

### GET `/projects/:id`
Get project details and sync status.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "project-1",
    "name": "Building A",
    "description": "A commercial building project",
    "status": "active",
    "progress": 65,
    "startDate": "2024-01-15",
    "endDate": "2025-06-30",
    "budget": 500000,
    "spent": 325000,
    "syncStatus": {
      "connected": true,
      "lastSyncedAt": "2024-01-20T10:30:00Z",
      "filesIndexed": 45
    }
  }
}
```

### PATCH `/projects/:id`
Update project details.

**Request:**
```json
{
  "name": "Updated Name",
  "status": "completed",
  "progress": 100
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Project updated"
}
```

### DELETE `/projects/:id`
Delete a project.

**Response (200):**
```json
{
  "success": true,
  "message": "Project deleted"
}
```

### GET `/projects/:id/files`
List indexed files for a project (paginated, filterable).

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20)
- `filter` (optional): Search filter
- `sort` (optional): Sort by field (default: name)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "projectId": "project-1",
    "files": [
      {
        "id": "file-1",
        "name": "Floor Plan A.pdf",
        "type": "application/pdf",
        "size": 2048000,
        "uploadedAt": "2024-01-20T10:30:00Z",
        "uploadedBy": "user-123",
        "indexed": true,
        "metadata": {
          "pages": 5,
          "extractedElements": 45
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 45
    }
  }
}
```

---

## Chat

### POST `/chat/sessions`
Create a new chat session.

**Request:**
```json
{
  "projectId": "project-1",
  "title": "Material Discussion"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "session-123456789",
    "projectId": "project-1",
    "userId": "user-123",
    "createdAt": "2024-01-20T10:30:00Z",
    "updatedAt": "2024-01-20T10:30:00Z",
    "title": "Material Discussion"
  }
}
```

### GET `/chat/sessions`
List chat sessions (optionally filtered by project).

**Query Parameters:**
- `projectId` (optional): Filter by project

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "session-123456789",
      "projectId": "project-1",
      "userId": "user-123",
      "createdAt": "2024-01-20T10:30:00Z",
      "updatedAt": "2024-01-20T10:35:00Z",
      "title": "Material Discussion"
    }
  ]
}
```

### POST `/chat/sessions/:id/message`
Send a message to chat session and get streamed response.

**Request:**
```json
{
  "message": "What are the material requirements for this project?"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "messageId": "msg-123456789",
    "sessionId": "session-123456789",
    "status": "processing"
  }
}
```

**Note:** The actual response will be streamed back via Server-Sent Events or WebSocket.

### GET `/chat/sessions/:id/messages`
Get chat history.

**Query Parameters:**
- `limit` (optional): Number of messages (default: 50)
- `offset` (optional): Offset for pagination (default: 0)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "sessionId": "session-123456789",
    "messages": [
      {
        "id": "msg-1",
        "sessionId": "session-123456789",
        "role": "user",
        "content": "What are the material requirements?",
        "createdAt": "2024-01-20T10:30:00Z",
        "updatedAt": "2024-01-20T10:30:00Z"
      },
      {
        "id": "msg-2",
        "sessionId": "session-123456789",
        "role": "assistant",
        "content": "Based on the project files...",
        "createdAt": "2024-01-20T10:30:05Z",
        "updatedAt": "2024-01-20T10:30:05Z"
      }
    ],
    "count": 2
  }
}
```

---

## Features (Pluggable Dashboard)

### GET `/features/registry`
Get all available features.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "features": [
      {
        "id": "material-extraction",
        "name": "Material Extraction",
        "description": "Automatically extract and categorize materials from documents",
        "category": "extraction",
        "configurable": true,
        "enabled": true,
        "config": {
          "minConfidence": 0.75,
          "autoAssign": true
        }
      },
      {
        "id": "cost-estimation",
        "name": "Cost Estimation",
        "description": "Calculate project costs based on extracted materials",
        "category": "estimation",
        "configurable": true,
        "enabled": true,
        "config": {
          "currency": "USD",
          "includeLabor": true,
          "laborCostPerHour": 50
        }
      }
    ],
    "count": 6
  }
}
```

### GET `/projects/:id/features`
Get enabled features for a project.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "projectId": "project-1",
    "features": [
      {
        "id": "material-extraction",
        "name": "Material Extraction",
        "description": "Automatically extract and categorize materials from documents",
        "category": "extraction",
        "configurable": true,
        "enabled": true,
        "config": { ... },
        "projectId": "project-1",
        "enabledAt": "2024-01-15T08:00:00Z",
        "enabledBy": "user-123"
      }
    ],
    "count": 3
  }
}
```

### PUT `/projects/:id/features/:fid`
Enable/disable or configure a feature for a project.

**Request:**
```json
{
  "enabled": true,
  "config": {
    "minConfidence": 0.80,
    "autoAssign": false
  }
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "material-extraction",
    "name": "Material Extraction",
    "description": "...",
    "category": "extraction",
    "configurable": true,
    "enabled": true,
    "config": {
      "minConfidence": 0.80,
      "autoAssign": false
    },
    "projectId": "project-1",
    "enabledAt": "2024-01-20T10:30:00Z",
    "enabledBy": "user-123"
  }
}
```

---

## Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `INVALID_REQUEST` | 400 | Missing or invalid request parameters |
| `UNAUTHORIZED` | 401 | Authentication failed or missing |
| `FORBIDDEN` | 403 | User lacks permission for this resource |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource already exists or conflicting state |
| `INVALID_CONFIG` | 400 | Invalid feature configuration |
| `AUTH_ERROR` | 500 | Authentication service error |
| `PROJECT_FETCH_ERROR` | 500 | Failed to fetch projects |
| `PROJECT_CREATE_ERROR` | 500 | Failed to create project |
| `PROJECT_UPDATE_ERROR` | 500 | Failed to update project |
| `PROJECT_DELETE_ERROR` | 500 | Failed to delete project |
| `PROJECT_FEATURES_ERROR` | 500 | Failed to fetch project features |
| `FEATURE_UPDATE_ERROR` | 500 | Failed to update feature |
| `SESSION_CREATE_ERROR` | 500 | Failed to create chat session |
| `SESSION_FETCH_ERROR` | 500 | Failed to fetch sessions |
| `MESSAGE_ERROR` | 500 | Failed to send message |
| `ONEDRIVE_CONNECT_ERROR` | 500 | Failed to connect OneDrive |
| `STATUS_ERROR` | 500 | Failed to fetch status |
| `SYNC_ERROR` | 500 | Failed to trigger sync |

---

## Authentication

All endpoints (except `/auth/login` and `/auth/signup`) require authentication via Bearer token in the Authorization header:

```
Authorization: Bearer <token>
```

---

## Rate Limiting

Rate limits are applied per user:
- 1000 requests per hour
- 10 concurrent requests

---

## Pagination

Endpoints that return lists support pagination:
- `page` (default: 1)
- `limit` (default: 20, max: 100)

---

## Timestamps

All timestamps are in ISO 8601 format (UTC):
```
2024-01-20T10:30:00Z
```
