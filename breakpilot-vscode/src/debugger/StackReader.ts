type DebugRequestSession = {
  customRequest(command: string, args: Record<string, unknown>): PromiseLike<unknown> | Promise<unknown>;
};

type StackResponse = {
  stackFrames?: Array<Record<string, unknown>>;
  totalFrames?: number;
};

export class StackReader {
  private readonly session: DebugRequestSession;

  constructor(session: DebugRequestSession) {
    this.session = session;
  }

  async read(threadId: number, offset: number, limit: number, pauseEpoch: number) {
    const response = await this.session.customRequest("stackTrace", {
      threadId,
      startFrame: offset,
      levels: limit
    }) as StackResponse;
    const stackFrames = Array.isArray(response?.stackFrames) ? response.stackFrames : [];
    const totalFrames = typeof response?.totalFrames === "number" && Number.isSafeInteger(response.totalFrames) && response.totalFrames >= 0
      ? response.totalFrames
      : undefined;
    const pageEnd = offset + stackFrames.length;
    const completeness = totalFrames === undefined
      ? "unknown"
      : pageEnd >= totalFrames
        ? "complete"
        : "partial";
    return {
      threadId,
      stackFrames,
      offset,
      ...(totalFrames === undefined ? {} : { totalFrames }),
      completeness,
      ...(completeness === "partial" && pageEnd > offset ? { nextOffset: pageEnd } : {}),
      ...(completeness === "complete" ? {} : { truncationReason: totalFrames === undefined ? "provider" : "limit" }),
      pauseEpoch
    };
  }
}
