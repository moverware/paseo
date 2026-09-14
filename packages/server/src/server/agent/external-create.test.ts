import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession } from "./agent-sdk-types.js";
import { externalCreationCommand, registerWithExternalPane } from "./external-create.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture(fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "external-create-"));
  dirs.push(dir);
  const events = join(dir, "events");
  const script = join(dir, "launcher.cjs");
  writeFileSync(
    script,
    `const fs=require('node:fs'); let s=''; process.stdin.on('data',b=>s+=b); process.stdin.on('end',()=>{const r=JSON.parse(s); fs.appendFileSync(${JSON.stringify(events)}, r.operation+'\\n'); if(r.operation==='start'){${fail ? "process.stderr.write('herdr is unavailable');process.exit(1);" : ""} process.stdout.write(JSON.stringify({sessionId:'native-id',transcriptPath:'/tmp/not-created.jsonl',labels:{origin:'herdr','herdr-pane':'w1:p2'}}));}else process.stdout.write('{}');});`,
  );
  const bindExternalSession = vi.fn();
  const close = vi.fn(async () => {});
  const register = vi.fn(async (labels) => ({ id: "agent-id", labels }));
  const unregister = vi.fn(async () => {});
  return {
    events,
    input: {
      argv: [process.execPath, script],
      agentId: "agent-id",
      config: { provider: "codex", cwd: dir },
      workspaceId: "home",
      session: { bindExternalSession, close } as unknown as AgentSession,
      register,
      unregister,
    },
    bindExternalSession,
    close,
  };
}

test("starts and binds a native pane before registering its mirror, then commits", async () => {
  const f = fixture();
  f.input.register.mockImplementation(async (labels) => {
    expect(f.bindExternalSession).toHaveBeenCalledWith({
      sessionId: "native-id",
      transcriptPath: "/tmp/not-created.jsonl",
      labels: { origin: "herdr", "herdr-pane": "w1:p2" },
    });
    return { id: "agent-id", labels };
  });
  expect(await registerWithExternalPane(f.input)).toEqual({
    id: "agent-id",
    labels: { origin: "herdr", "herdr-pane": "w1:p2" },
  });
  expect(readFileSync(f.events, "utf8")).toBe("start\ncommit\n");
  expect(f.close).not.toHaveBeenCalled();
});

test("startup failure is visible and never falls back to a daemon turn", async () => {
  const f = fixture(true);
  await expect(registerWithExternalPane(f.input)).rejects.toThrow("herdr is unavailable");
  expect(f.input.register).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  expect(readFileSync(f.events, "utf8")).toBe("start\nrollback\n");
});

test("registration failure removes only the prepared pane", async () => {
  const f = fixture();
  f.input.register.mockRejectedValue(new Error("registration failed"));
  await expect(registerWithExternalPane(f.input)).rejects.toThrow("registration failed");
  expect(readFileSync(f.events, "utf8")).toBe("start\nrollback\n");
  expect(f.close).toHaveBeenCalledOnce();
});

test("unconfigured and noninteractive creation retains provider creation", async () => {
  const f = fixture();
  expect(await registerWithExternalPane({ ...f.input, argv: null })).toEqual({
    id: "agent-id",
    labels: undefined,
  });
  expect(f.bindExternalSession).not.toHaveBeenCalled();
  expect(externalCreationCommand(false, "codex")).toBeNull();
  expect(externalCreationCommand(true, "pi")).toBeNull();
});
