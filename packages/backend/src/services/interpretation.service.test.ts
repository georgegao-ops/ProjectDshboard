import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../config/env";
import { interpretationService } from "./interpretation.service";

describe("interpretationService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.CHAT_INTERPRETER_ENABLE_LLM = "true";
    process.env.DEEPSEEK_API_KEY = "test-key";
    resetEnvCache();
  });

  afterEach(() => {
    delete process.env.CHAT_INTERPRETER_ENABLE_LLM;
    delete process.env.DEEPSEEK_API_KEY;
    resetEnvCache();
  });

  it("normalizes invalid llm intents to general_qa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: "unknown_intent",
                  confidence: 0.95,
                  alternatives: [{ intent: "bogus", confidence: 0.9 }],
                }),
              },
            },
          ],
        }),
      })
    );

    const interpreted = await interpretationService.interpret({
      query: "give me a project update",
    });

    expect(interpreted.source).toBe("llm");
    expect(interpreted.intent).toBe("general_qa");
    expect(interpreted.alternatives?.[0]?.intent).toBe("general_qa");
  });
});