import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UUID } from "@contractor/shared";
import { chatCoordinatorService } from "./chat-coordinator.service";
import { chatService } from "./chat.service";

function asUuid(value: string): UUID {
  return value as UUID;
}

describe("chatService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("routes chat replies through the phase 4.5c coordinator with indexed sources", async () => {
    vi.spyOn(chatCoordinatorService, "generateReply").mockResolvedValue({
      content: "Coordinator answer from indexed context.",
      sources: [
        {
          fileId: asUuid("file-1"),
          fileName: "schedule-report.pdf",
          relevance: 0.91,
        },
      ],
      domains: ["scheduling", "cost"],
      cacheHit: false,
      coordinator: {
        domains: ["scheduling", "cost"],
        cacheHit: false,
        splitSignals: ["domain_specific_tools_likely_needed"],
        specialistAgents: [
          {
            agent: "sched_agent",
            domains: ["scheduling"],
            sourceCount: 1,
            nodeCount: 1,
            durationMs: 3,
          },
        ],
        estimatedContextTokens: 120,
        contradictions: [],
        telemetry: {
          routeMs: 2,
          retrievalMs: 3,
          mergeMs: 1,
          agentMs: 4,
          totalMs: 10,
        },
      },
    });

    const { session } = await chatService.createSession(asUuid("project-1"));
    const response = await chatService.sendMessage(session.id, "What are the schedule risks?");

    expect(chatCoordinatorService.generateReply).toHaveBeenCalledWith(
      asUuid("project-1"),
      "What are the schedule risks?",
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(response.content).toContain("indexed context");
    expect(response.sources).toHaveLength(1);
    expect(response.coordinator?.domains).toEqual(["scheduling", "cost"]);
    expect(response.coordinator?.specialistAgents[0]?.agent).toBe("sched_agent");
  });
});