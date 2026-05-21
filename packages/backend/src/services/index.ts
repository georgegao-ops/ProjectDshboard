// Public service API — only services consumed directly by server.ts or external routes
export { authService } from "./auth.service";
export { chatService } from "./chat.service";
export { documentStorageService } from "./document-storage.service";
export { documentRelationshipService } from "./document-relationship.service";
export { featureService } from "./feature.service";
export { healthService } from "./health.service";
export { indexingService } from "./indexing.service";
export { indexingMaintenanceService } from "./indexing-maintenance.service";
export { startIndexingWorker } from "./indexing-runtime.service";
export { interpretationService } from "./interpretation.service";
export { onedriveService } from "./onedrive.service";
export { projectService } from "./project.service";
export { retrievalService } from "./retrieval.service";
export { syncService } from "./sync.service";

