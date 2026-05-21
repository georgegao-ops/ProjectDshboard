/**
 * Priority Scoring Service
 *
 * Scores each file 0–100 to determine processing order.
 * Higher priority files are indexed first so the AI chat branch
 * can answer common questions within 30 minutes of a new connection.
 *
 * Scoring factors:
 *  - File type / MIME type (PDFs and DOCX score high)
 *  - Recency (recently modified files score high)
 *  - Folder path (key folders like "Contracts", "RFIs" score high)
 *  - File name keywords (RFI, submittal, schedule, contract...)
 *  - File size (very large files deprioritised slightly)
 */

export interface PriorityScoringInput {
  fileName: string;
  filePath: string;
  mimeType?: string;
  fileType?: string; // extension e.g. 'pdf'
  fileSize?: number; // bytes
  lastModifiedAt?: Date;
}

// ============================================================
// Scoring weight tables
// ============================================================

/** MIME type base scores */
const MIME_SCORES: Array<[RegExp, number]> = [
  [/pdf/i,                                                             30],
  [/officedocument\.wordprocessingml/i,                                25], // DOCX
  [/officedocument\.spreadsheetml/i,                                   20], // XLSX
  [/officedocument\.presentationml/i,                                  15], // PPTX
  [/text\/(plain|csv)/i,                                               12],
  [/image\//i,                                                          8],
  [/message\/rfc822|application\/vnd\.ms-outlook/i,                    10], // EML/MSG
];

/** Folder-path keyword scores (applied once per matching segment) */
const FOLDER_SCORES: Array<[RegExp, number]> = [
  [/contracts?/i,         20],
  [/rfis?/i,              18],
  [/submittals?/i,        18],
  [/change[\s_-]?orders?/i, 18],
  [/specifications?|specs?/i, 15],
  [/schedules?/i,         15],
  [/permits?/i,           14],
  [/drawings?/i,          12],
  [/meeting[\s_-]?minutes?/i, 10],
  [/invoices?/i,          10],
  [/safety/i,              8],
  [/photos?|images?/i,     5],
];

/** File name keyword scores */
const NAME_SCORES: Array<[RegExp, number]> = [
  [/\brfi[\s_\-#]?\d+/i,            18],
  [/submittal/i,                     18],
  [/change[\s_-]?order/i,           18],
  [/\bcontract\b/i,                  16],
  [/\bschedule\b/i,                  15],
  [/\bspecification\b|spec\b/i,      14],
  [/\bpermit\b/i,                    14],
  [/\bdrawing\b|\bdwg\b/i,           12],
  [/\bmeeting[\s_-]?minutes\b/i,     10],
  [/\binvoice\b/i,                   10],
  [/\bjsa\b|\bjha\b/i,                8],
];

// Maximum file size to give recency bonus – files over ~200 MB are slightly deprioritised
const LARGE_FILE_THRESHOLD_BYTES = 200 * 1024 * 1024;
const HUGE_FILE_THRESHOLD_BYTES  = 500 * 1024 * 1024;

// ============================================================
// Public API
// ============================================================

export const priorityScoringService = {
  /**
   * Compute a 0–100 priority score for a file.
   * Higher = process first.
   */
  score(input: PriorityScoringInput): number {
    let score = 0;

    // 1. File type score (up to 30 pts)
    const mime = input.mimeType ?? "";
    for (const [pattern, pts] of MIME_SCORES) {
      if (pattern.test(mime)) {
        score += pts;
        break;
      }
    }
    // Fallback: extension
    if (score === 0) {
      const ext = (input.fileType ?? "").toLowerCase();
      if (ext === "pdf") score += 28;
      else if (["docx", "doc"].includes(ext)) score += 24;
      else if (["xlsx", "xls"].includes(ext)) score += 18;
      else if (["csv", "txt"].includes(ext)) score += 10;
    }

    // 2. Folder path score (up to 20 pts)
    const pathLower = input.filePath.toLowerCase();
    let folderBonus = 0;
    for (const [pattern, pts] of FOLDER_SCORES) {
      if (pattern.test(pathLower)) {
        folderBonus = Math.max(folderBonus, pts);
      }
    }
    score += folderBonus;

    // 3. File name keyword score (up to 18 pts)
    const nameLower = input.fileName.toLowerCase();
    let nameBonus = 0;
    for (const [pattern, pts] of NAME_SCORES) {
      if (pattern.test(nameLower)) {
        nameBonus = Math.max(nameBonus, pts);
      }
    }
    score += nameBonus;

    // 4. Recency bonus – recently modified files get up to 15 extra pts
    if (input.lastModifiedAt) {
      const ageMs  = Date.now() - input.lastModifiedAt.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays <= 7)   score += 15;
      else if (ageDays <= 30)  score += 10;
      else if (ageDays <= 90)  score += 5;
    }

    // 5. Size penalty – very large files deprioritised slightly
    if (input.fileSize) {
      if (input.fileSize > HUGE_FILE_THRESHOLD_BYTES)  score -= 10;
      else if (input.fileSize > LARGE_FILE_THRESHOLD_BYTES) score -= 5;
    }

    return Math.max(0, Math.min(100, score));
  },
};
