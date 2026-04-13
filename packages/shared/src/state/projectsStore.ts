/**
 * Projects Store — Manages selected project and project list
 */

import { create } from "zustand";
import type { Project, OneDriveStatus } from "../types/entities";

export interface ProjectsState {
  projects: Project[];
  currentProject: Project | null;
  oneDriveStatus: OneDriveStatus | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (project: Project | null) => void;
  setOneDriveStatus: (status: OneDriveStatus) => void;
  addProject: (project: Project) => void;
  updateProject: (project: Project) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  currentProject: null,
  oneDriveStatus: null,
  isLoading: false,
  error: null,

  setProjects: (projects) => set({ projects }),
  setCurrentProject: (currentProject) => set({ currentProject }),
  setOneDriveStatus: (oneDriveStatus) => set({ oneDriveStatus }),
  addProject: (project) =>
    set((state) => ({
      projects: [...state.projects, project],
      currentProject: state.currentProject || project,
    })),
  updateProject: (updatedProject) =>
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === updatedProject.id ? updatedProject : p
      ),
      currentProject:
        state.currentProject?.id === updatedProject.id
          ? updatedProject
          : state.currentProject,
    })),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
}));
