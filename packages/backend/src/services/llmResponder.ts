/**
 * 6.5 LLM Response Generation Service
 * Generates responses using Claude Sonnet with streaming and source tracking
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMRequest, LLMResponse, StreamEvent, ConversationMessage, Citation } from '../types/rag';
import { AssembledContext } from '../types/rag';

export class LLMResponder {
  private anthropic: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  // Pricing (as of 2024)
  private pricing = {
    inputCostPer1MTokens: 3.0, // $3 per 1M input tokens
    outputCostPer1MTokens: 15.0, // $15 per 1M output tokens
  };

  constructor(config?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }) {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    this.model = config?.model || 'claude-3-5-sonnet-20241022';
    this.maxTokens = config?.maxTokens || 1024;
    this.temperature = config?.temperature || 0.7;
  }

  /**
   * Generate response with streaming support
   * @param request LLM request with context and query
   * @param onChunk Callback for each streamed chunk
   */
  async generateResponse(
    request: LLMRequest,
    onChunk?: (event: StreamEvent) => void
  ): Promise<LLMResponse> {
    try {
      console.log('🤖 Generating response with Claude Sonnet...');

      // Build conversation history
      const messages = this.buildMessages(request);

      // Prepare system prompt
      const systemPrompt = request.systemPrompt || this.getDefaultSystemPrompt();

      let responseText = '';
      let stopReason = 'end_turn';

      if (onChunk) {
        onChunk({
          type: 'response_start',
          data: 'Starting response generation...',
          timestamp: new Date().toISOString(),
        });
      }

      // Stream response
      const stream = await this.anthropic.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: systemPrompt,
        messages,
      });

      for await (const chunk of stream) {
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta?.type === 'text_delta'
        ) {
          responseText += chunk.delta.text;

          if (onChunk) {
            onChunk({
              type: 'response_chunk',
              data: chunk.delta.text,
              timestamp: new Date().toISOString(),
            });
          }
        } else if (chunk.type === 'message_stop') {
          stopReason = 'end_turn';
        } else if (chunk.type === 'message_start' && chunk.message) {
          stopReason = chunk.message.stop_reason || 'end_turn';
        }
      }

      // Extract citations from response
      const citations = this.extractCitationsFromResponse(
        responseText,
        request.context.citations
      );

      // Calculate token usage (estimated from streamed response)
      const tokenUsage = this.estimateTokenUsage(
        systemPrompt,
        messages,
        responseText
      );

      // Emit complete event
      if (onChunk) {
        onChunk({
          type: 'sources',
          data: citations,
          timestamp: new Date().toISOString(),
        });

        onChunk({
          type: 'response_end',
          data: 'Response complete',
          timestamp: new Date().toISOString(),
        });
      }

      const response: LLMResponse = {
        messageId: `msg-${Date.now()}`,
        responseText,
        citations,
        tokenUsage,
        generatedAt: new Date().toISOString(),
      };

      console.log(`✅ Response generated (${responseText.length} chars)`);

      return response;
    } catch (error) {
      console.error('LLM response generation failed:', error);

      if (onChunk) {
        onChunk({
          type: 'error',
          data: error instanceof Error ? error : new Error('Unknown error'),
          timestamp: new Date().toISOString(),
        });
      }

      throw error;
    }
  }

  /**
   * Build message history for LLM
   */
  private buildMessages(request: LLMRequest): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];

    // Add conversation history if available
    if (request.conversationHistory && request.conversationHistory.length > 0) {
      for (const msg of request.conversationHistory.slice(-10)) {
        // Keep last 10 messages for context
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    // Add current user query with context
    const contextText = this.formatContextForMessage(request.context);
    const userMessage = `${contextText}\n\nUser's question: ${request.userQuery}`;

    messages.push({
      role: 'user',
      content: userMessage,
    });

    return messages;
  }

  /**
   * Format context for inclusion in message
   */
  private formatContextForMessage(context: AssembledContext): string {
    if (context.chunks.length === 0) {
      return 'No relevant documents found. Based on available information:';
    }

    const sources = context.chunks
      .map(
        (chunk, idx) =>
          `[Source ${idx + 1}: ${chunk.fileName}${chunk.specSection ? ` - Section ${chunk.specSection}` : ''}]\n${chunk.chunkText}`
      )
      .join('\n\n---\n\n');

    return `Here are relevant excerpts from construction documents:\n\n${sources}\n\nBased on this context:`;
  }

  /**
   * Extract citations from response text
   * Looks for [Source N] references
   */
  private extractCitationsFromResponse(
    responseText: string,
    availableCitations: Citation[]
  ): Citation[] {
    const citations: Citation[] = [];
    const sourceRegex = /\[Source (\d+)\]/g;
    let match;

    const usedIndices = new Set<number>();
    while ((match = sourceRegex.exec(responseText)) !== null) {
      const index = parseInt(match[1], 10) - 1; // Convert to 0-indexed
      if (index >= 0 && index < availableCitations.length && !usedIndices.has(index)) {
        citations.push(availableCitations[index]);
        usedIndices.add(index);
      }
    }

    // If no explicit citations found, include top sources
    if (citations.length === 0 && availableCitations.length > 0) {
      citations.push(availableCitations[0]);
      if (availableCitations.length > 1) {
        citations.push(availableCitations[1]);
      }
    }

    return citations;
  }

  /**
   * Estimate token usage (before streaming completes)
   * This is approximate based on text length
   */
  private estimateTokenUsage(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    responseText: string
  ): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  } {
    // Rough estimation: 1 token ≈ 4 characters for English
    const systemTokens = Math.ceil(systemPrompt.length / 4);
    const messagesTokens = Math.ceil(
      messages.reduce(
        (sum, m) =>
          sum +
          (typeof m.content === 'string'
            ? m.content.length
            : m.content.reduce(
                (s, c) => s + (typeof c === 'string' ? c.length : (c as any).text?.length || 0),
                0
              )),
        0
      ) / 4
    );

    const promptTokens = systemTokens + messagesTokens;
    const completionTokens = Math.ceil(responseText.length / 4);
    const totalTokens = promptTokens + completionTokens;

    // Calculate cost
    const inputCost = (promptTokens / 1_000_000) * this.pricing.inputCostPer1MTokens;
    const outputCost = (completionTokens / 1_000_000) * this.pricing.outputCostPer1MTokens;
    const estimatedCost = inputCost + outputCost;

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
    };
  }

  /**
   * Get default system prompt for construction documents
   */
  private getDefaultSystemPrompt(): string {
    return `You are an expert construction document assistant. Your role is to help users find and understand information from construction specifications, drawings, RFIs, submittals, and other project documents.

IMPORTANT RULES:
1. Base your answers ONLY on the provided document excerpts
2. Always cite sources using [Source N] format, e.g., [Source 1]
3. If information is not in the provided documents, clearly state: "This information is not available in the provided documents."
4. NEVER fabricate specifications, requirements, or details
5. Be precise and specific - reference exact section numbers when available
6. If you're uncertain about something, express your confidence level
7. When a user asks about a specific spec section, ensure you reference the correct CSI MasterFormat code
8. Provide context for your answers to help users understand the full requirement

If multiple sources address the topic, briefly note which provides the most relevant information.`;
  }

  /**
   * Check if response fits within token limits
   */
  static validateTokenUsage(usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }): {
    valid: boolean;
    warning?: string;
  } {
    const maxTotalTokens = 4096; // Claude 3.5 Sonnet limit for a single message

    if (usage.totalTokens > maxTotalTokens) {
      return {
        valid: false,
        warning: `Total tokens (${usage.totalTokens}) exceeds limit (${maxTotalTokens})`,
      };
    }

    if (usage.completionTokens > 1024) {
      return {
        valid: true,
        warning: `High token usage for completion (${usage.completionTokens})`,
      };
    }

    return { valid: true };
  }
}
