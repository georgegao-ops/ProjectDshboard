import type {
  ChatHistoryResponse,
  ChatHistoryTurn,
  ChatSessionsListResponse,
  ChatMessage,
  CreateChatSessionResponse,
  InterpretationFeedbackEvent,
  OpenDocContext,
  SendChatMessageResponse,
  UUID,
} from "@contractor/shared";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  chatMessages,
  chatSessions,
  getDbIfInitialized,
} from "../db";
import { AppError } from "../lib/errors";
import { chatCoordinatorService } from "./chat-coordinator.service";
import type { RequestUserContext } from "./service-types";
import { toUuid } from "./service-types";

const sessions = new Map<UUID, CreateChatSessionResponse["session"]>();

export const chatService = {
  async createSession(
    projectId: UUID,
    user?: RequestUserContext
  ): Promise<CreateChatSessionResponse> {
    const db = getDbIfInitialized();
    const session = {
      id: toUuid(randomUUID()),
      projectId,
      userId: toUuid(user?.id ?? "user-123"),
      createdAt: new Date(),
    };

    if (db) {
      await db.insert(chatSessions).values({
        id: session.id,
        projectId: session.projectId,
        userId: session.userId,
        createdAt: session.createdAt,
      });
    } else {
      sessions.set(session.id, session);
    }

    return {
      session,
    };
  },

  async sendMessage(
    sessionId: UUID,
    message: string,
    history?: ChatHistoryTurn[],
    openDocs?: OpenDocContext[],
    activeDocFileName?: string,
    activeDocFileId?: UUID,
    feedback?: InterpretationFeedbackEvent,
    user?: RequestUserContext
  ): Promise<SendChatMessageResponse> {
    const db = getDbIfInitialized();
    const userId = user?.id ? toUuid(user.id) : undefined;

    const session = db
      ? (
          await db
            .select()
            .from(chatSessions)
            .where(eq(chatSessions.id, sessionId))
            .limit(1)
        )[0]
      : sessions.get(sessionId);

    if (!session) {
      throw new AppError(404, "chat_session_not_found", "Chat session not found");
    }

    if (userId && session.userId !== userId) {
      throw new AppError(404, "chat_session_not_found", "Chat session not found");
    }

    if (db) {
      await db.insert(chatMessages).values({
        id: toUuid(randomUUID()),
        sessionId,
        role: "user",
        content: message,
        feedback: feedback as unknown as Record<string, unknown>,
      });
    }

    const coordinatorReply = await chatCoordinatorService.generateReply(
      toUuid(session.projectId),
      message,
      history,
      openDocs,
      activeDocFileName,
      activeDocFileId
    );

    const response: SendChatMessageResponse = {
      messageId: toUuid(randomUUID()),
      role: "assistant",
      content: coordinatorReply.content,
      sources: coordinatorReply.sources,
      citations: coordinatorReply.citations,
      interpretation: coordinatorReply.interpretation,
      suggestions: coordinatorReply.suggestions,
      autoOpenFileName: coordinatorReply.autoOpenFileName,
      coordinator: coordinatorReply.coordinator,
      createdAt: new Date(),
    };

    if (db) {
      await db.insert(chatMessages).values({
        id: response.messageId,
        sessionId,
        role: "assistant",
        content: response.content,
        sources: response.sources as unknown as Record<string, unknown>,
        interpretation: response.interpretation as unknown as Record<string, unknown>,
        createdAt: response.createdAt,
      });
    }

    return response;
  },

  async listSessionsForUser(user?: RequestUserContext): Promise<ChatSessionsListResponse> {
    if (!user?.id) {
      return { sessions: [] };
    }

    const userId = toUuid(user.id);
    const db = getDbIfInitialized();

    if (db) {
      const dbSessions = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.userId, userId));
      return {
        sessions: dbSessions.map((session) => ({
          id: toUuid(session.id),
          projectId: toUuid(session.projectId),
          userId: toUuid(session.userId),
          createdAt: session.createdAt,
        })),
      };
    }

    return {
      sessions: Array.from(sessions.values()).filter((session) => session.userId === userId),
    };
  },

  async getHistoryForUser(sessionId: UUID, user?: RequestUserContext): Promise<ChatHistoryResponse> {
    if (!user?.id) {
      throw new AppError(404, "chat_session_not_found", "Chat session not found");
    }

    const db = getDbIfInitialized();
    const userId = toUuid(user.id);

    if (db) {
      const session = (
        await db
          .select()
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.id, sessionId),
              eq(chatSessions.userId, userId)
            )
          )
          .limit(1)
      )[0];

      if (!session) {
        throw new AppError(404, "chat_session_not_found", "Chat session not found");
      }

      const rows = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId))
        .orderBy(asc(chatMessages.createdAt));

      const messages: ChatMessage[] = rows.map((row) => ({
        id: toUuid(row.id),
        sessionId: toUuid(row.sessionId),
        role: row.role,
        content: row.content,
        sources: Array.isArray(row.sources)
          ? (row.sources as ChatMessage["sources"])
          : undefined,
        interpretation:
          row.interpretation && typeof row.interpretation === "object"
            ? (row.interpretation as ChatMessage["interpretation"])
            : undefined,
        feedback:
          row.feedback && typeof row.feedback === "object"
            ? (row.feedback as ChatMessage["feedback"])
            : undefined,
        createdAt: row.createdAt,
      }));

      return {
        messages,
        total: messages.length,
      };
    }

    const session = sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new AppError(404, "chat_session_not_found", "Chat session not found");
    }

    return {
      messages: [],
      total: 0,
    };
  },
};
