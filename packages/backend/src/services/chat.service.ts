import type {
  ChatHistoryResponse,
  ChatSessionsListResponse,
  CreateChatSessionResponse,
  SendChatMessageResponse,
  UUID,
} from "@contractor/shared";
import { randomUUID } from "node:crypto";
import type { RequestUserContext } from "./service-types";
import { retrievalService } from "./retrieval.service";
import { toUuid } from "./service-types";

const sessions = new Map<UUID, CreateChatSessionResponse["session"]>();

export const chatService = {
  async createSession(
    projectId: UUID,
    user?: RequestUserContext
  ): Promise<CreateChatSessionResponse> {
    const session = {
      id: toUuid(randomUUID()),
      projectId,
      userId: toUuid(user?.id ?? "user-123"),
      createdAt: new Date(),
    };
    sessions.set(session.id, session);

    return {
      session,
    };
  },

  async listSessions(): Promise<ChatSessionsListResponse> {
    return { sessions: Array.from(sessions.values()) };
  },

  async sendMessage(
    sessionId: UUID,
    message: string
  ): Promise<SendChatMessageResponse> {
    const session = sessions.get(sessionId);

    return {
      messageId: toUuid(randomUUID()),
      role: "assistant",
      content: `Echo: ${message}`,
      sources: await retrievalService.retrieveSources(session?.projectId, message),
      createdAt: new Date(),
    };
  },

  async getHistory(_sessionId: UUID): Promise<ChatHistoryResponse> {
    return {
      messages: [],
      total: 0,
    };
  },
};
