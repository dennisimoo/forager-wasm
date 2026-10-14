import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, readdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import worker from "../src/worker.js";
import versions from "../public/download-versions.json" with { type: "json" };
import manifest from "../public/web-game/manifest.json" with { type: "json" };

const root = new URL("../public/", import.meta.url);
for (const name of (await readdir(root)).filter(
  (name) => name.startsWith("browser-") && name.endsWith(".mjs"),
)) {
  const file = new URL(name, root);
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(
    /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)/g,
  )) {
    await access(new URL(match[1], file));
  }
}
for (const path of [
  "native-build/diagnostic-O1.wasm",
  ...manifest.map((name) => `web-game/${name}`),
]) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(new URL(path, root)))
    hash.update(chunk);
  assert.equal(hash.digest("hex"), versions[path], path);
}
for (const [path, type] of [
  ["native-build/diagnostic-O1.wasm", "application/wasm"],
  ["web-game/data.win", "application/octet-stream"],
]) {
  for (const method of ["GET", "HEAD"]) {
    let requested;
    const object = {
      body: "test",
      size: 4,
      httpEtag: '"test"',
      writeHttpMetadata() {},
    };
    const env = {
      GAME_ASSETS: {
        async get(key) {
          requested = key;
          return object;
        },
        async head(key) {
          requested = key;
          return object;
        },
      },
    };
    const response = await worker.fetch(
      new Request(`https://example.test/${path}?v=test`, { method }),
      env,
    );
    assert.equal(requested, path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), type);
    assert.equal(
      response.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal(
      response.headers.get("Cross-Origin-Embedder-Policy"),
      "require-corp",
    );
    assert.equal(await response.text(), method === "HEAD" ? "" : "test");
  }
  const missing = await worker.fetch(
    new Request(`https://example.test/${path}`),
    {
      GAME_ASSETS: {
        async get() {
          return null;
        },
      },
    },
  );
  assert.equal(missing.status, 404);
}
const page = await worker.fetch(new Request("https://example.test/"), {
  ASSETS: {
    async fetch() {
      return new Response("page");
    },
  },
});
assert.equal(await page.text(), "page");
console.log("Native assets, content hashes, and Worker routes passed.");
