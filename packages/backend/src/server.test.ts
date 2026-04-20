import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./server";
import { authService, onedriveService, projectService } from "./services";
import { resetEnvCache } from "./config/env";

describe("backend server", () => {
  beforeEach(() => {
    authService.resetForTests();
    onedriveService.resetForTests();
    projectService.resetForTests();
    resetEnvCache();
    vi.restoreAllMocks();
  });

  it("returns API health with a request id", async () => {
    const app = await createApp();

    const response = await request(app).get("/health/api");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.body.status).toBe("ok");
  });

  it("returns typed app errors from auth refresh", async () => {
    const app = await createApp();

    const response = await request(app)
      .post("/api/auth/refresh")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("refresh_token_missing");
    expect(response.body.requestId).toBeTruthy();
  });

  it("returns the shared feature registry shape", async () => {
    const app = await createApp();

    const response = await request(app).get("/api/features/registry");

    expect(response.status).toBe(200);
    expect(response.body.features).toEqual([
      expect.objectContaining({
        id: "onedrive",
        route: "/project/:id/onedrive",
        enabled: true,
      }),
      expect.objectContaining({
        id: "chat",
        route: "/project/:id/chat",
        enabled: true,
      }),
    ]);
  });

  it("requires authentication for protected project routes", async () => {
    const app = await createApp();

    const response = await request(app).get("/api/projects");

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("unauthorized");
  });

  it("persists created projects for the authenticated organization", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-secret");
    resetEnvCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "microsoft-access-token",
          refresh_token: "microsoft-refresh-token",
          id_token: [
            "header",
            Buffer.from(
              JSON.stringify({
                oid: "user-123",
                tid: "tenant-123",
                name: "Jane Contractor",
                preferred_username: "jane@contractor.ai",
              })
            ).toString("base64url"),
            "signature",
          ].join("."),
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile email",
        }),
      })
    );

    const app = await createApp();
    const redirectUri = "http://localhost:3000/auth/callback";
    const start = await request(app)
      .get("/api/auth/login")
      .query({ redirectUri });
    const authorizationUrl = new URL(start.headers.location, "https://login.microsoftonline.com");
    const state = authorizationUrl.searchParams.get("state");

    const login = await request(app)
      .post("/api/auth/login")
      .send({ code: "oauth-code", redirectUri, state });

    const createResponse = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({
        name: "Airport Expansion",
        onedriveFolderId: "folder-123",
      });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.project.name).toBe("Airport Expansion");
    expect(createResponse.body.project.onedriveFolderId).toBe("folder-123");

    const listResponse = await request(app)
      .get("/api/projects")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.projects).toEqual([
      expect.objectContaining({
        id: createResponse.body.project.id,
        name: "Airport Expansion",
        onedriveFolderId: "folder-123",
        orgId: expect.any(String),
      }),
    ]);
  });

  it("exchanges an OAuth code for a backend session token", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-secret");
    resetEnvCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "microsoft-access-token",
          refresh_token: "microsoft-refresh-token",
          id_token: [
            "header",
            Buffer.from(
              JSON.stringify({
                oid: "user-123",
                tid: "tenant-123",
                name: "Jane Contractor",
                preferred_username: "jane@contractor.ai",
              })
            ).toString("base64url"),
            "signature",
          ].join("."),
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile email",
        }),
      })
    );

    const app = await createApp();
    const redirectUri = "http://localhost:3000/auth/callback";

    const start = await request(app)
      .get("/api/auth/login")
      .query({ redirectUri });

    expect(start.status).toBe(302);

    const authorizationUrl = new URL(start.headers.location, "https://login.microsoftonline.com");
    const state = authorizationUrl.searchParams.get("state");

    const response = await request(app)
      .post("/api/auth/login")
      .send({
        code: "oauth-code",
        redirectUri,
        state,
      });

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      email: "jane@contractor.ai",
      name: "Jane Contractor",
    });
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.refreshToken).toBeTruthy();

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${response.body.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("jane@contractor.ai");
  });

  it("completes OneDrive connect flow and browses folders", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-secret");
    resetEnvCache();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes("/oauth2/v2.0/token")) {
          return new Response(
            JSON.stringify({
              access_token: "microsoft-access-token",
              refresh_token: "microsoft-refresh-token",
              id_token: [
                "header",
                Buffer.from(
                  JSON.stringify({
                    oid: "user-123",
                    tid: "tenant-123",
                    name: "Jane Contractor",
                    preferred_username: "jane@contractor.ai",
                  })
                ).toString("base64url"),
                "signature",
              ].join("."),
              expires_in: 3600,
              token_type: "Bearer",
              scope: "openid profile email offline_access Files.Read User.Read",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.endsWith("/v1.0/me/drive?$select=id,driveType,webUrl")) {
          return new Response(
            JSON.stringify({ id: "drive-1", driveType: "business", webUrl: "https://drive" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.endsWith("/v1.0/me/drive/root/children?$select=id,name,webUrl,folder,size,lastModifiedDateTime")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "folder-1",
                  name: "Specs",
                  webUrl: "https://drive/specs",
                  folder: {},
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.endsWith("/v1.0/me/drive/items/folder-1/children?$select=id,name,folder,file,size,eTag,lastModifiedDateTime")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "file-pdf-1",
                  name: "spec.pdf",
                  file: { mimeType: "application/pdf" },
                  size: 12345,
                  eTag: "etag-pdf",
                  lastModifiedDateTime: "2026-04-15T10:00:00Z",
                },
                {
                  id: "nested-folder-1",
                  name: "Submittals",
                  folder: {},
                  size: 0,
                  eTag: "etag-folder",
                  lastModifiedDateTime: "2026-04-15T10:01:00Z",
                },
                {
                  id: "file-txt-1",
                  name: "notes.txt",
                  file: { mimeType: "text/plain" },
                  size: 501,
                  eTag: "etag-txt",
                  lastModifiedDateTime: "2026-04-15T10:02:00Z",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.endsWith("/v1.0/me/drive/items/nested-folder-1/children?$select=id,name,folder,file,size,eTag,lastModifiedDateTime")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "file-docx-1",
                  name: "rfi.docx",
                  file: {
                    mimeType:
                      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  },
                  size: 2048,
                  eTag: "etag-docx",
                  lastModifiedDateTime: "2026-04-15T10:03:00Z",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.endsWith("/v1.0/me/drive/items/file-pdf-1/content")) {
          return new Response("PDF preview content for specification section and HVAC scope.", {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
        }

        if (url.endsWith("/v1.0/me/drive/items/file-docx-1/content")) {
          return new Response("DOCX preview content for RFI response details and submittal notes.", {
            status: 200,
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const app = await createApp();
    const redirectUri = "http://localhost:3000/auth/callback";
    const authStart = await request(app).get("/api/auth/login").query({ redirectUri });
    const authUrl = new URL(authStart.headers.location, "https://login.microsoftonline.com");
    const authState = authUrl.searchParams.get("state");

    const login = await request(app)
      .post("/api/auth/login")
      .send({ code: "oauth-code", redirectUri, state: authState });

    const onedriveRedirectUri = "http://localhost:3000/onedrive/callback";
    const connectStart = await request(app)
      .get("/api/onedrive/connect/start")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .query({ redirectUri: onedriveRedirectUri });

    expect(connectStart.status).toBe(200);
    expect(connectStart.body.authorizationUrl).toContain("login.microsoftonline.com");

    const connect = await request(app)
      .post("/api/onedrive/connect")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({
        code: "onedrive-code",
        state: connectStart.body.state,
        redirectUri: onedriveRedirectUri,
      });

    expect(connect.status).toBe(200);
    expect(connect.body.connected).toBe(true);

    const status = await request(app)
      .get("/api/onedrive/status")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(status.status).toBe(200);
    expect(status.body.connected).toBe(true);
    expect(status.body.accountEmail).toBe("jane@contractor.ai");
    expect(status.body.tenantId).toBe("tenant-123");
    expect(status.body.driveType).toBe("business");

    const browse = await request(app)
      .get("/api/onedrive/browse")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(browse.status).toBe(200);
    expect(browse.body.items).toEqual([
      expect.objectContaining({
        id: "folder-1",
        name: "Specs",
        isFolder: true,
      }),
    ]);

    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({
        name: "Terminal Retrofit",
        onedriveFolderId: "folder-1",
      });

    expect(project.status).toBe(200);

    const sync = await request(app)
      .post("/api/onedrive/sync")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ projectId: project.body.project.id });

    expect(sync.status).toBe(200);
    expect(sync.body.syncStarted).toBe(true);
    expect(sync.body.scannedFileCount).toBe(3);
    expect(sync.body.supportedFileCount).toBe(2);
    expect(sync.body.unsupportedFileCount).toBe(1);

    const files = await request(app)
      .get(`/api/projects/${project.body.project.id}/files`)
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .query({ page: "1", pageSize: "10" });

    expect(files.status).toBe(200);
    expect(files.body.total).toBe(3);
    expect(files.body.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileName: "spec.pdf", indexStatus: "pending" }),
        expect.objectContaining({ fileName: "rfi.docx", indexStatus: "pending" }),
        expect.objectContaining({ fileName: "notes.txt", indexStatus: "failed" }),
      ])
    );

    const progress = await request(app)
      .get(`/api/projects/${project.body.project.id}/indexing/progress`)
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(progress.status).toBe(200);
    expect(progress.body).toEqual(
      expect.objectContaining({
        total: 3,
        pending: 2,
        processing: 0,
        indexed: 0,
        failed: 1,
        completionPercent: 33,
      })
    );
  });

  it("revokes the backend session on logout", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-secret");
    resetEnvCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "microsoft-access-token",
          refresh_token: "microsoft-refresh-token",
          id_token: [
            "header",
            Buffer.from(
              JSON.stringify({
                oid: "user-123",
                tid: "tenant-123",
                name: "Jane Contractor",
                preferred_username: "jane@contractor.ai",
              })
            ).toString("base64url"),
            "signature",
          ].join("."),
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile email",
        }),
      })
    );

    const app = await createApp();
    const redirectUri = "http://localhost:3000/auth/callback";
    const start = await request(app)
      .get("/api/auth/login")
      .query({ redirectUri });
    const authorizationUrl = new URL(start.headers.location, "https://login.microsoftonline.com");
    const state = authorizationUrl.searchParams.get("state");

    const login = await request(app)
      .post("/api/auth/login")
      .send({ code: "oauth-code", redirectUri, state });

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ refreshToken: login.body.refreshToken });

    expect(logout.status).toBe(204);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(me.status).toBe(401);
    expect(me.body.error).toBe("unauthorized");
  });
});