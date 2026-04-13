/**
 * Chat Store — Manages chat sessions and messages
 */

import { create } from "zustand";
import type { ChatSession, ChatMessage, UUID } from "../types/entities";

export interface ChatState {
  sessions: ChatSession[];
  currentSessionId: UUID | null;
  messages: Map<UUID, ChatMessage[]>; // sessionId -> messages
  isLoading: boolean;
  error: string | null;

  // Actions
  setSessions: (sessions: ChatSession[]) => void;
  setCurrentSession: (sessionId: UUID | null) => void;
  addSession: (session: ChatSession) => void;
  setMessages: (sessionId: UUID, messages: ChatMessage[]) => void;
  addMessage: (sessionId: UUID, message: ChatMessage) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  currentSessionId: null,
  messages: new Map(),
  isLoading: false,
  error: null,

  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (currentSessionId) => set({ currentSessionId }),
  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
      currentSessionId: state.currentSessionId || session.id,
    })),
  setMessages: (sessionId, messages) =>
    set((state) => {
      const newMessages = new Map(state.messages);
      newMessages.set(sessionId, messages);
      return { messages: newMessages };
    }),
  addMessage: (sessionId, message) =>
    set((state) => {
      const newMessages = new Map(state.messages);
      const sessionMessages = newMessages.get(sessionId) || [];
      newMessages.set(sessionId, [...sessionMessages, message]);
      return { messages: newMessages };
    }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
}));
