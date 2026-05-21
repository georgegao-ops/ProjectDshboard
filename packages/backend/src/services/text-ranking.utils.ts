/**
 * Common English stop words that appear in virtually every document chunk and
 * are useless for keyword-hit scoring. Filtering these prevents false-positive
 * chunk matches where every chunk appears to "match" a query.
 */
const QUERY_STOP_WORDS = new Set([
  // Articles / determiners
  "the", "a", "an", "this", "that", "these", "those",
  // Prepositions
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "off",
  "into", "onto", "about", "above", "below", "between", "through",
  "per", "as", "based",
  // Conjunctions
  "and", "or", "but", "nor", "so", "yet",
  // Pronouns
  "i", "we", "you", "he", "she", "it", "they", "me", "us", "him", "her", "them",
  "my", "our", "your", "his", "its", "their",
  // Question words used as framing (not content)
  "what", "which", "who", "when", "where", "why", "how",
  // Common verbs / auxiliaries
  "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  "get", "give", "make", "take", "use",
  // Common filler words
  "any", "all", "not", "no", "yes", "also", "too", "just", "only",
  "then", "than", "more", "most", "some", "such", "each",
  "tell", "show", "list", "give", "provide", "describe",
  "there", "here", "now", "please",
]);

export function tokenizeQuery(
  query: string,
  minLength = 3,
  maxTokens?: number
): string[] {
  const tokens = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= minLength)
        .filter((token) => !QUERY_STOP_WORDS.has(token))
    )
  );

  if (typeof maxTokens === "number") {
    return tokens.slice(0, maxTokens);
  }

  return tokens;
}

export function keywordHitScore(tokens: string[], text: string): number {
  const lower = text.toLowerCase();
  return tokens.reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0);
}
