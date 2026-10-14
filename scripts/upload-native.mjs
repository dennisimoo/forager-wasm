import { spawnSync } from "node:child_process";

for (const [path, type] of [
  ["native-build/diagnostic-O1.wasm", "application/wasm"],
  ["web-game/data.win", "application/octet-stream"],
]) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `forager-wasm-4-1-9-assets/${path}`,
      "--file",
      `public/${path}`,
      "--content-type",
      type,
      "--remote",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
