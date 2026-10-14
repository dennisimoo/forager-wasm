import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const { default: versions } = await import("../public/download-versions.json", {
  with: { type: "json" },
});
for (const [archive, path] of [
  ["diagnostic-O1.wasm.gz", "native-build/diagnostic-O1.wasm"],
  ["data.win.gz", "web-game/data.win"],
]) {
  const destination = new URL(`public/${path}`, root);
  const temporary = new URL(`${destination.href}.next`);
  await mkdir(dirname(fileURLToPath(destination)), { recursive: true });
  await pipeline(
    createReadStream(new URL(`artifacts/${archive}`, root)),
    createGunzip(),
    createWriteStream(temporary),
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(temporary)) hash.update(chunk);
  if (hash.digest("hex") !== versions[path])
    throw new Error(`Content hash mismatch: ${path}`);
  await rename(temporary, destination);
  console.log(`Prepared ${path}`);
}
