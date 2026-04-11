/**
 * 6.1 Query Processing & Parsing Service
 * Extracts structured hints from user queries to enable better search
 */

import { ParsedQuery } from '../types/rag';
import Anthropic from '@anthropic-ai/sdk';

export class QueryParser {
  private anthropic: Anthropic;
  private enableHaikuFallback: boolean;

  constructor(enableHaikuFallback: boolean = true) {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    this.enableHaikuFallback = enableHaikuFallback;
  }

  /**
   * Parse user query to extract structured hints
   * @param query User's natural language query
   * @returns ParsedQuery with extracted metadata
   */
  async parseQuery(query: string): Promise<ParsedQuery> {
    // First, try regex patterns for common formats
    const regexResult = this.parseWithRegex(query);
    if (regexResult.confidence > 0.7) {
      return regexResult;
    }

    // If regex confidence is low and fallback is enabled, use Claude Haiku
    if (this.enableHaikuFallback) {
      return this.parseWithHaiku(query);
    }

    return regexResult;
  }

  /**
   * Parse query using regex patterns
   * Looks for common architectural specifications format (XX XX XX)
   */
  private parseWithRegex(query: string): ParsedQuery {
    const parsed: ParsedQuery = {
      rawQuery: query,
      topics: [],
      keywords: [],
      confidence: 0,
    };

    // Pattern 1: Spec section format (XX XX XX or XX-XX-XX or XX.XX.XX)
    // CSI MasterFormat uses 3 digit groups separated by space, dash, or period
    const specMatch = query.match(
      /\b(\d{2}[\s\-_.]?\d{2}[\s\-_.]?\d{2})\b/g
    );
    if (specMatch) {
      // Normalize format to spaces (XX XX XX)
      parsed.specSection = specMatch[0]
        .replace(/[\s\-_.]/g, ' ')
        .trim();
      parsed.confidence += 0.4;
    }

    // Pattern 2: Extract common construction topics
    const topicKeywords = [
      'insulation',
      'roofing',
      'concrete',
      'steel',
      'windows',
      'doors',
      'hvac',
      'plumbing',
      'electrical',
      'masonry',
      'flooring',
      'drywall',
      'paint',
      'ceiling',
      'foundation',
      'framing',
      'membrane',
      'sealant',
      'caulk',
      'waterproofing',
      'fire-rated',
      'acoustical',
      'sheathing',
    ];

    const foundTopics = topicKeywords.filter((topic) =>
      query.toLowerCase().includes(topic)
    );

    parsed.topics = foundTopics;
    if (foundTopics.length > 0) {
      parsed.confidence += 0.3;
    }

    // Pattern 3: Extract keywords (2+ character words, exclude common words)
    const stopWords = new Set([
      'the',
      'and',
      'or',
      'a',
      'an',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'is',
      'what',
      'does',
      'say',
      'about',
      'tell',
      'show',
      'requirements',
      'requirements',
      'specification',
      'spec',
    ]);

    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter(
        (word) =>
          word.length >= 3 &&
          !stopWords.has(word) &&
          !/^\d+$/.test(word) // exclude pure numbers
      );

    parsed.keywords = [...new Set(words)].slice(0, 5); // Top 5 unique keywords
    if (parsed.keywords.length > 0) {
      parsed.confidence += 0.2;
    }

    // Cap confidence at 1.0
    parsed.confidence = Math.min(parsed.confidence, 1.0);

    return parsed;
  }

  /**
   * Parse query using Claude Haiku for better extraction
   * More accurate but slower than regex
   */
  private async parseWithHaiku(query: string): Promise<ParsedQuery> {
    try {
      const prompt = `Extract structured information from this construction/architectural query:

Query: "${query}"

Return a JSON object with:
{
  "specSection": "XX XX XX format if detected, or null",
  "topics": ["list", "of", "construction", "topics"],
  "keywords": ["key", "words"],
  "confidence": 0.0-1.0
}

Rules:
- specSection: CSI MasterFormat codes are 3 groups of 2 digits (e.g., "23 05 00")
- topics: construction-related topics like "insulation", "roofing", "concrete", etc.
- keywords: important terms from the query
- confidence: how confident you are in the extraction (0-1)

Return ONLY valid JSON, no markdown or explanation.`;

      const message = await this.anthropic.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = message.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type');
      }

      // Extract JSON from response
      const jsonText = content.text.trim();

      let extracted;
      try {
        extracted = JSON.parse(jsonText);
      } catch {
        // Try to extract JSON if wrapped in markdown
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('Could not parse JSON');
        }
        extracted = JSON.parse(jsonMatch[0]);
      }

      return {
        rawQuery: query,
        specSection: extracted.specSection || undefined,
        topics: extracted.topics || [],
        keywords: extracted.keywords || [],
        confidence: extracted.confidence || 0.5,
      };
    } catch (error) {
      console.error('Haiku parsing failed, falling back to regex:', error);
      // Fall back to regex result
      return this.parseWithRegex(query);
    }
  }

  /**
   * Validate and normalize a spec section code
   * @param specCode Raw spec code (e.g., "23-05-00")
   * @returns Normalized code (e.g., "23 05 00") or null if invalid
   */
  static validateSpecSection(specCode: string): string | null {
    // Remove any separators and normalize
    const normalized = specCode
      .replace(/[\s\-_.]/g, '')
      .trim();

    // Should be 6 digits exactly
    if (!/^\d{6}$/.test(normalized)) {
      return null;
    }

    // Format as XX XX XX
    return `${normalized.slice(0, 2)} ${normalized.slice(2, 4)} ${normalized.slice(4)}`;
  }
}
