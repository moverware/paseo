import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceUnarchiveResult {
  workspaceId: string;
  status: "restored";
}

const workspaceUnarchiveSchema: OutputSchema<WorkspaceUnarchiveResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
  ],
};

export async function runUnarchiveCommand(
  workspaceId: string,
  options: { host?: string },
  _command: Command,
): Promise<SingleResult<WorkspaceUnarchiveResult>> {
  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    await client.restoreWorkspace(workspaceId);
    return {
      type: "single",
      data: { workspaceId, status: "restored" },
      schema: workspaceUnarchiveSchema,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_UNARCHIVE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
