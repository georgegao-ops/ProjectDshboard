/**
 * Features Store — Manages enabled features and configuration per project
 */

import { create } from "zustand";
import type { Feature, ProjectFeature } from "../types/entities";

export interface FeaturesState {
  enabledFeatures: (ProjectFeature & { feature: Feature })[];
  isLoading: boolean;
  error: string | null;

  // Actions
  setEnabledFeatures: (
    features: (ProjectFeature & { feature: Feature })[]
  ) => void;
  updateFeature: (featureId: string, config: Record<string, unknown>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useFeaturesStore = create<FeaturesState>((set) => ({
  enabledFeatures: [],
  isLoading: false,
  error: null,

  setEnabledFeatures: (enabledFeatures) => set({ enabledFeatures }),

  updateFeature: (featureId, config) =>
    set((state) => ({
      enabledFeatures: state.enabledFeatures.map((f) =>
        f.featureId === featureId ? { ...f, config } : f
      ),
    })),

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
}));
