import { Readable } from 'stream';
import { db } from '../db/client';
import { fileRecords, indexingJobs } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface DocumentMetadata {
  summary: string;
  category: 'submittal' | 'spec' | 'drawing' | 'rfi' | 'photo' | 'report' | 'other';
  specSection?: string;
  sheetNumber?: string;
  revision?: string;
  keyTopics: string[];
  tags: string[];
}

export class DocumentProcessingService {
  /**
   * Extract text from document based on file type
   */
  static async extractText(filePath: string, fileType: string): Promise<string> {
    try {
      switch (fileType) {
        case 'pdf':
          return await this.extractPdf(filePath);
        case 'docx':
          return await this.extractDocx(filePath);
        case 'image':
          return await this.extractImageOcr(filePath);
        case 'txt':
          return await this.extractText(filePath, 'txt');
        default:
          throw new Error(`Unsupported file type: ${fileType}`);
      }
    } catch (error) {
      console.error(`Failed to extract text from ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Extract text from PDF
   * Uses pdf-parse library (lightweight, no external dependencies)
   */
  private static async extractPdf(filePath: string): Promise<string> {
    try {
      // Dynamic import to keep dependency light
      const pdfParse = await import('pdf-parse');
      const fs = await import('fs');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse.default(buffer);
      return data.text;
    } catch (error) {
      throw new Error(`Failed to extract PDF text: ${error}`);
    }
  }

  /**
   * Extract text from DOCX
   * Uses mammoth library for OOXML parsing
   */
  private static async extractDocx(filePath: string): Promise<string> {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } catch (error) {
      throw new Error(`Failed to extract DOCX text: ${error}`);
    }
  }

  /**
   * Extract text from image via OCR
   * Uses Tesseract.js (runs in Node.js)
   */
  private static async extractImageOcr(filePath: string): Promise<string> {
    try {
      const Tesseract = await import('tesseract.js');
      const { data } = await Tesseract.recognize(filePath, 'eng');
      return data.text;
    } catch (error) {
      throw new Error(`Failed to extract image text via OCR: ${error}`);
    }
  }

  /**
   * Classify document using Claude Haiku
   * Analyzes first 2 pages (or first ~4000 tokens) to generate metadata
   */
  static async classifyDocument(
    text: string,
    fileName: string
  ): Promise<DocumentMetadata> {
    try {
      // For MVP, use Claude Haiku (cost-effective at ~$0.55/1M input tokens)
      // TODO: Initialize Anthropic client from environment
      // const client = new Anthropic();

      // Truncate to first 2 pages (~4000 tokens) for classification
      const truncatedText = text.substring(0, 8000);

      // TODO: Replace with actual API call
      // const response = await client.messages.create({
      //   model: 'claude-3-5-haiku-20241022',
      //   max_tokens: 500,
      //   messages: [{
      //     role: 'user',
      //     content: `Classify this construction document and extract metadata.
      //
      //Document name: ${fileName}
      //
      //Content:
      //${truncatedText}
      //
      //Return valid JSON with this exact structure:
      //{
      //  "summary": "Brief summary (max 500 chars)",
      //  "category": "submittal|spec|drawing|rfi|photo|report|other",
      //  "specSection": "CSI section if applicable (e.g., 23 05 00)",
      //  "sheetNumber": "Drawing sheet identifier if applicable",
      //  "revision": "Revision number if found",
      //  "keyTopics": ["topic1", "topic2"],
      //  "tags": ["tag1", "tag2"]
      //}
      //
      //Only return valid JSON, no other text.`
      //   }]
      // });

      // Parse mock response for now
      const mockResponse: DocumentMetadata = {
        summary: `Document: ${fileName}`,
        category: this.inferCategory(fileName),
        keyTopics: this.extractTopicsFromFilename(fileName),
        tags: [this.inferCategory(fileName)],
      };

      return mockResponse;
    } catch (error) {
      console.error('Failed to classify document:', error);
      // Return basic classification based on filename
      return {
        summary: `Document: ${fileName}`,
        category: this.inferCategory(fileName),
        keyTopics: this.extractTopicsFromFilename(fileName),
        tags: [this.inferCategory(fileName)],
      };
    }
  }

  /**
   * Process a document: extract text, classify, and update database
   */
  static async processDocument(
    fileId: string,
    filePath: string,
    fileType: string,
    fileName: string,
    indexingJobId: string
  ): Promise<void> {
    try {
      // Update job status
      await db
        .update(indexingJobs)
        .set({ status: 'processing' })
        .where(eq(indexingJobs.id, indexingJobId));

      // Extract text
      console.log(`Extracting text from: ${fileName}`);
      const extractedText = await this.extractText(filePath, fileType);

      // Classify document
      console.log(`Classifying document: ${fileName}`);
      const metadata = await this.classifyDocument(extractedText, fileName);

      // Update file record with metadata
      await db
        .update(fileRecords)
        .set({
          summary: metadata.summary,
          docCategory: metadata.category,
          specSection: metadata.specSection,
          sheetNumber: metadata.sheetNumber,
          revision: metadata.revision,
          keyTopics: metadata.keyTopics,
          tags: metadata.tags,
          indexStatus: 'processing', // Will be updated to 'indexed' after chunking/embedding
          updatedAt: new Date(),
        })
        .where(eq(fileRecords.id, fileId));

      console.log(`Document processed successfully: ${fileName}`);
    } catch (error) {
      console.error(`Failed to process document ${fileName}:`, error);

      // Update job with error status
      await db
        .update(indexingJobs)
        .set({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        })
        .where(eq(indexingJobs.id, indexingJobId));

      throw error;
    }
  }

  /**
   * Helper: Infer document category from filename
   */
  private static inferCategory(
    fileName: string
  ): DocumentMetadata['category'] {
    const lower = fileName.toLowerCase();
    if (lower.includes('spec')) return 'spec';
    if (lower.includes('submittal')) return 'submittal';
    if (lower.includes('rfi')) return 'rfi';
    if (lower.includes('drawing') || lower.includes('.dwg')) return 'drawing';
    if (lower.includes('photo') || lower.match(/\.(jpg|png|jpeg)$/)) return 'photo';
    if (lower.includes('report')) return 'report';
    return 'other';
  }

  /**
   * Helper: Extract topics from filename
   */
  private static extractTopicsFromFilename(fileName: string): string[] {
    // Simple keyword extraction from filename
    const keywords = fileName
      .replace(/\.[^/.]+$/, '') // Remove extension
      .split(/[-_\s]+/)
      .filter((word) => word.length > 3 && !word.match(/^\d+$/));

    return keywords.slice(0, 5); // Return top 5 keywords
  }
}
