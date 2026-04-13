/**
 * Feature Registry System — Enables pluggable dashboard features
 * Each feature can be enabled/disabled per project
 */

import type { UUID } from "../types/entities";

export type FeaturePlatform = "ios" | "android" | "web";

/**
 * Feature Module — Contract that all features must implement
 */
export interface FeatureModule {
  id: string; // 'onedrive', 'chat', 'daily_photos', etc.
  name: string;
  icon: string; // icon identifier (lucide or @expo/vector-icons)
  route: string; // frontend route
  description: string;
  platforms: FeaturePlatform[]; // which platforms support this
  defaultEnabled: boolean;
  order: number; // sort order on dashboard

  // Backend configuration (optional)
  apiRoutes?: string[]; // routes this feature adds
  migrations?: string[]; // SQL migration files
  permissions?: string[]; // e.g., ['CAMERA', 'PHOTO_LIBRARY'] for mobile
  requiresBackgroundSync?: boolean;

  // Feature-specific configuration
  config?: Record<string, unknown>;
}

/**
 * Default MVP Features
 */
export const BUILTIN_FEATURES = {
  onedrive: {
    id: "onedrive",
    name: "OneDrive",
    icon: "cloud",
    route: "/project/:id/onedrive",
    description: "Browse and sync OneDrive documents",
    platforms: ["ios", "android", "web"],
    defaultEnabled: true,
    order: 1,
  } as FeatureModule,

  chat: {
    id: "chat",
    name: "Chat",
    icon: "message-square",
    route: "/project/:id/chat",
    description: "AI-powered document search and Q&A",
    platforms: ["ios", "android", "web"],
    defaultEnabled: true,
    order: 2,
  } as FeatureModule,
};

/**
 * Feature registry — maps feature IDs to their modules
 */
export class FeatureRegistry {
  private features: Map<string, FeatureModule> = new Map();

  constructor() {
    // Register built-in features
    Object.values(BUILTIN_FEATURES).forEach((feature) => {
      this.register(feature);
    });
  }

  register(feature: FeatureModule): void {
    this.features.set(feature.id, feature);
  }

  get(id: string): FeatureModule | undefined {
    return this.features.get(id);
  }

  getAll(): FeatureModule[] {
    return Array.from(this.features.values()).sort((a, b) => a.order - b.order);
  }

  getAllForPlatform(platform: FeaturePlatform): FeatureModule[] {
    return this.getAll().filter((f) => f.platforms.includes(platform));
  }

  has(id: string): boolean {
    return this.features.has(id);
  }
}

// Singleton instance
export const featureRegistry = new FeatureRegistry();
