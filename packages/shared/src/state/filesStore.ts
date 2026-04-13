/**
 * Files Store — Manages indexed files and file records
 */

import { create } from "zustand";
import type { FileRecord, UUID } from "../types/entities";

export interface FilesState {
  files: FileRecord[];
  currentPage: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  filters: {
    search?: string;
    category?: string;
    tags?: string[];
  };

  // Actions
  setFiles: (files: FileRecord[], total: number, page: number) => void;
  addFiles: (files: FileRecord[]) => void;
  setCurrentPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: FilesState["filters"]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useFilesStore = create<FilesState>((set) => ({
  files: [],
  currentPage: 1,
  pageSize: 50,
  total: 0,
  hasMore: false,
  isLoading: false,
  error: null,
  filters: {},

  setFiles: (files, total, page) =>
    set({
      files,
      total,
      currentPage: page,
      hasMore: page * 50 < total,
    }),

  addFiles: (files) =>
    set((state) => ({
      files: [...state.files, ...files],
    })),

  setCurrentPage: (currentPage) => set({ currentPage }),
  setPageSize: (pageSize) => set({ pageSize }),
  setFilters: (filters) => set({ filters, currentPage: 1 }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
}));
