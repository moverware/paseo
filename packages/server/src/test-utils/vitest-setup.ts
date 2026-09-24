import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load package-local .env.test first for integration/E2E credentials, then repo-root .env fallback.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.resolve(serverRoot, ".env.test"), override: true });
dotenv.config({ path: path.resolve(serverRoot, "../.env") });

process.env.PASEO_SUPERVISED = "0";
// FORK: the daemon reads its external-command hooks (native pane creation,
// pane prompt delivery) from the config under PASEO_HOME. Tests must never
// pick those up from the developer's real ~/.paseo, where they are
// configured, so an unset home resolves to an empty scratch directory.
process.env.PASEO_HOME ??= mkdtempSync(path.join(os.tmpdir(), "paseo-test-home-"));
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
process.env.SSH_ASKPASS = "/usr/bin/false";
process.env.SSH_ASKPASS_REQUIRE = "force";
process.env.DISPLAY = process.env.DISPLAY ?? "1";
