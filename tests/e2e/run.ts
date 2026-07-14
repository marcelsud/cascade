import { spawn } from "node:child_process";
import { once } from "node:events";
import { assertE2EInfrastructure } from "./helpers/infrastructure.js";

await assertE2EInfrastructure();

const child = spawn(process.execPath, ["test", "tests/e2e"], {
  stdio: "inherit",
  env: process.env,
});
const [code] = (await once(child, "exit")) as [number | null];
if (code !== 0) process.exitCode = code ?? 1;
