/**
 * Expo Configuration
 * Configures the iOS and Android apps built with Expo and React Native
 */

import { ExpoConfig, getDefaultConfig } from "expo/config";

const config = getDefaultConfig(__dirname);

const expoConfig: ExpoConfig = {
  ...config,
  name: "ContractorAI",
  slug: "contractor-ai",
  version: "0.0.1",
  scheme: ["contractor"],
  orientation: "portrait",
  icon: "./assets/icon.png",
  splash: {
    image: "./assets/splash.png",
  },
  updates: {
    fallbackToCacheTimeout: 0,
    url: "https://u.expo.dev/YOUR_EAS_PROJECT_ID",
  },
  runtimeVersion: {
    policy: "appVersion",
  },
  assetBundlePatterns: ["**/*"],
  ios: {
    bundleIdentifier: "com.contractorai.app",
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription: "Take project photos (Phase 2)",
      NSPhotoLibraryUsageDescription:
        "Upload site photos (Phase 2)",
      NSLocationWhenInUseUsageDescription:
        "Tag photo location (Phase 2)",
    },
  },
  android: {
    package: "com.contractorai.app",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
    },
    permissions: [
      "CAMERA",
      "READ_EXTERNAL_STORAGE",
      "ACCESS_FINE_LOCATION",
    ],
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    [
      "expo-image-picker",
      {
        photosPermission:
          "Allow ContractorAI to access your photos.",
        cameraPermission:
          "Allow ContractorAI to access your camera.",
      },
    ],
    "expo-auth-session",
  ],
};

export default expoConfig;
