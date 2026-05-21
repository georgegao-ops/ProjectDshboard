/**
 * Document Relationship Service
 *
 * Detects and stores cross-file relationships after indexing:
 *   - RFI references a drawing number → rfi "references" drawing
 *   - Submittal tied to a vendor name found on another doc
 *   - Change order references an RFI number
 *   - Drawing revision supersedes prior revision
 *   - Meeting minutes "responds_to" an RFI
 *
 * Runs as a post-indexing pass after all files in a project are indexed.
 */

import type { UUID } from "@contractor/shared";
import { eq, and, ne } from "drizzle-orm";
import { getDbIfInitialized, documentRelationships, fileRecords } from "../db";
import { logger } from "../lib/logger";
import type { ConstructionCategory } from "../db/schema";

// ============================================================
// Types
// ============================================================

interface FileSnapshot {
  id: string;
  fileName: string;
  docCategory: string | null;
  extractedFields: Record<string, string> | null;
  revision: string | null;
  sheetNumber: string | null;
  keyTopics: string[] | null;
}

type RelationshipInsert = {
  projectId: string;
  sourceFileId: string;
  targetFileId: string;
  relationType: string;
  confidence: number;
  metadata?: Record<string, string>;
};

// ============================================================
// Detection Rules
// ============================================================

function detectRelationships(files: FileSnapshot[]): RelationshipInsert[] {
  const results: RelationshipInsert[] = [];

  // Build quick-lookup maps
  const byCategory = new Map<string, FileSnapshot[]>();
  for (const f of files) {
    const cat = f.docCategory ?? "unknown";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(f);
  }

  const drawingMap = new Map<string, FileSnapshot>(); // sheet_number → file
  for (const f of byCategory.get("drawing") ?? []) {
    if (f.sheetNumber) drawingMap.set(f.sheetNumber.toUpperCase(), f);
  }

  // Rule 1: RFI "references" drawings mentioned in extracted fields
  for (const rfi of byCategory.get("rfi") ?? []) {
    const drawingNum = rfi.extractedFields?.drawingNumber;
    if (drawingNum) {
      const drawing = drawingMap.get(drawingNum.toUpperCase());
      if (drawing && drawing.id !== rfi.id) {
        results.push({
          projectId: "",
          sourceFileId: rfi.id,
          targetFileId: drawing.id,
          relationType: "references",
          confidence: 85,
          metadata: { drawingNumber: drawingNum },
        });
      }
    }
  }

  // Rule 2: Change order "responds_to" RFI
  for (const co of byCategory.get("change_order") ?? []) {
    const rfiNum = co.extractedFields?.rfiNumber;
    if (rfiNum) {
      for (const rfi of byCategory.get("rfi") ?? []) {
        if (rfi.extractedFields?.rfiNumber === rfiNum) {
          results.push({
            projectId: "",
            sourceFileId: co.id,
            targetFileId: rfi.id,
            relationType: "responds_to",
            confidence: 90,
            metadata: { rfiNumber: rfiNum },
          });
        }
      }
    }
  }

  // Rule 3: Newer drawing revision "supersedes" older revision of same sheet
  const drawingsBySheet = new Map<string, FileSnapshot[]>();
  for (const f of byCategory.get("drawing") ?? []) {
    if (!f.sheetNumber) continue;
    const key = f.sheetNumber.toUpperCase();
    if (!drawingsBySheet.has(key)) drawingsBySheet.set(key, []);
    drawingsBySheet.get(key)!.push(f);
  }
  for (const [, revisionList] of drawingsBySheet) {
    if (revisionList.length < 2) continue;
    // Sort by revision label alphabetically (Rev A < Rev B < Rev C...)
    const sorted = revisionList
      .filter((f) => f.revision)
      .sort((a, b) => (a.revision ?? "").localeCompare(b.revision ?? ""));
    for (let i = 1; i < sorted.length; i++) {
      const newer = sorted[i]!;
      const older = sorted[i - 1]!;
      results.push({
        projectId: "",
        sourceFileId: newer.id,
        targetFileId: older.id,
        relationType: "supersedes",
        confidence: 80,
        metadata: { sheetNumber: newer.sheetNumber ?? "", newRevision: newer.revision ?? "", oldRevision: older.revision ?? "" },
      });
    }
  }

  // Rule 4: Submittal "references" spec section if spec exists
  for (const sub of byCategory.get("submittal") ?? []) {
    const specSec = sub.extractedFields?.specSection;
    if (specSec) {
      for (const spec of byCategory.get("spec") ?? []) {
        if (spec.extractedFields?.specSection === specSec || spec.keyTopics?.some((t) => specSec.includes(t))) {
          results.push({
            projectId: "",
            sourceFileId: sub.id,
            targetFileId: spec.id,
            relationType: "references",
            confidence: 75,
            metadata: { specSection: specSec },
          });
          break; // one match per submittal
        }
      }
    }
  }

  return results;
}

// ============================================================
// Public API
// ============================================================

export const documentRelationshipService = {
  /**
   * Analyse all indexed files in a project and persist inferred relationships.
   * Should be called after bulk indexing completes.
   */
  async buildRelationships(projectId: UUID): Promise<{ created: number }> {
    const db = getDbIfInitialized();
    if (!db) {
      logger.warn("document-relationships.skipped", { reason: "No DB" });
      return { created: 0 };
    }

    try {
      const rows = await db
        .select({
          id: fileRecords.id,
          fileName: fileRecords.fileName,
          docCategory: fileRecords.docCategory,
          extractedFields: fileRecords.extractedFields,
          revision: fileRecords.revision,
          sheetNumber: fileRecords.sheetNumber,
          keyTopics: fileRecords.keyTopics,
        })
        .from(fileRecords)
        .where(and(eq(fileRecords.projectId, projectId), eq(fileRecords.indexStatus, "indexed")));

      const snapshots: FileSnapshot[] = rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        docCategory: r.docCategory ?? null,
        extractedFields: r.extractedFields as Record<string, string> | null,
        revision: r.revision ?? null,
        sheetNumber: r.sheetNumber ?? null,
        keyTopics: r.keyTopics ?? null,
      }));

      const detected = detectRelationships(snapshots);
      if (detected.length === 0) return { created: 0 };

      // Backfill projectId and deduplicate against existing rows
      const existing = await db
        .select({ sourceFileId: documentRelationships.sourceFileId, targetFileId: documentRelationships.targetFileId, relationType: documentRelationships.relationType })
        .from(documentRelationships)
        .where(eq(documentRelationships.projectId, projectId));

      const existingSet = new Set(existing.map((e) => `${e.sourceFileId}:${e.targetFileId}:${e.relationType}`));

      const toInsert = detected
        .map((d) => ({ ...d, projectId }))
        .filter((d) => !existingSet.has(`${d.sourceFileId}:${d.targetFileId}:${d.relationType}`));

      if (toInsert.length === 0) return { created: 0 };

      await db.insert(documentRelationships).values(
        toInsert.map((d) => ({
          projectId: d.projectId,
          sourceFileId: d.sourceFileId,
          targetFileId: d.targetFileId,
          relationType: d.relationType,
          confidence: d.confidence,
          metadata: d.metadata ?? null,
        }))
      );

      logger.info("document-relationships.built", { projectId, created: toInsert.length });
      return { created: toInsert.length };
    } catch (err) {
      logger.error("document-relationships.failed", { projectId, error: err instanceof Error ? err.message : String(err) });
      return { created: 0 };
    }
  },
};
