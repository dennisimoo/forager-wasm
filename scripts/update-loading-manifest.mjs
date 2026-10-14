import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = [
  "butterscotch.wasm",
  ...JSON.parse(await readFile("public/files.json", "utf8")),
];
const bytes = {},
  hash = createHash("sha256");
for (const file of files) {
  const data = await readFile(`public/${file}`);
  bytes[file] = data.length;
  hash.update(file).update("\0").update(data);
}
await writeFile(
  "public/ui/loading.json",
  JSON.stringify({ version: hash.digest("hex"), bytes }, null, 2) + "\n",
);
