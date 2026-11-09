import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const data = await readFile("public/butterscotch.wasm");
const version = createHash("sha256").update(data).digest("hex");
await writeFile(
  "public/ui/loading.json",
  JSON.stringify(
    { version, bytes: { "butterscotch.wasm": data.length } },
    null,
    2,
  ) + "\n",
);
