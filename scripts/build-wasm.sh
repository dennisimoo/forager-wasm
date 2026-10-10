#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v emcmake >/dev/null; then
  echo 'Activate Emscripten 6.0.12 before building: source /path/to/emsdk/emsdk_env.sh' >&2
  exit 1
fi
emcmake cmake -S runtime -B build -DCMAKE_BUILD_TYPE=Release -DPLATFORM=web -DBACKEND=web -DENABLE_LEGACY_GL=OFF
cmake --build build -j2
cp build/butterscotch.mjs build/butterscotch.wasm public/
node --input-type=module - <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const files = ['butterscotch.wasm', ...JSON.parse(await readFile('public/files.json', 'utf8'))];
const bytes = {}, hash = createHash('sha256');
for (const file of files) {
  const data = await readFile(`public/${file}`);
  bytes[file] = data.length;
  hash.update(file).update('\0').update(data);
}
await writeFile('public/ui/loading.json', JSON.stringify({ version: hash.digest('hex'), bytes }, null, 2) + '\n');
JS
