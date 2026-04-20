type LogLevel = "info" | "warn" | "error";

type LogMeta = Record<string, unknown>;

function serializeError(error: unknown): LogMeta {
  if (error instanceof Error) {
    const enriched = error as Error & {
      code?: unknown;
      statusCode?: unknown;
      details?: unknown;
    };

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: enriched.code,
      statusCode: enriched.statusCode,
      details: enriched.details,
    };
  }

  return { error };
}

function write(level: LogLevel, event: string, meta: LogMeta = {}): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...meta,
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const logger = {
  info(event: string, meta?: LogMeta): void {
    write("info", event, meta);
  },
  warn(event: string, meta?: LogMeta): void {
    write("warn", event, meta);
  },
  error(event: string, error: unknown, meta?: LogMeta): void {
    write("error", event, {
      ...meta,
      ...serializeError(error),
    });
  },
};
