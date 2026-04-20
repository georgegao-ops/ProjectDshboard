import type { JobsOptions } from "bullmq";
import type { UUID } from "@contractor/shared";
import { syncService } from "./sync.service";

function asUuid(value: string): UUID {
  return value as UUID;
}

describe("syncService", () => {
  it("queues an indexing job with a deterministic idempotency key", async () => {
    const enqueue = vi.fn(async (_payload: unknown, options: JobsOptions) => ({
      jobId: String(options.jobId),
      mode: "redis" as const,
    }));

    const response = await syncService.queueProjectSync(
      asUuid("project-123"),
      undefined,
      {
        enqueue,
      }
    );

    expect(enqueue).toHaveBeenCalledOnce();
    expect(response).toEqual({
      syncStarted: true,
      message: "Sync queued",
      jobId: "indexing:project-123",
    });
  });
});
