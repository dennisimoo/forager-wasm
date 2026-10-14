// Cache Storage accommodates the large WASM and game files, independently
// of the browser's ordinary HTTP cache. Content hashes invalidate each file.
export async function openDownloadCache(report) {
  const response = await fetch('./download-versions.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Download versions: HTTP ${response.status}`);
  const versions = await response.json();
  let cache;
  try { cache = await caches.open('forager-4.1.9-downloads'); }
  catch (error) { report('download-cache-unavailable', String(error)); }
  const urls = new Map(Object.entries(versions).map(([path, hash]) => {
    const url = new URL(path, import.meta.url);
    url.searchParams.set('v', hash);
    return [path, url.href];
  }));
  if (cache) {
    const current = new Set(urls.values());
    for (const request of await cache.keys()) {
      if (!current.has(request.url)) await cache.delete(request);
    }
  }
  return async path => {
    const url = urls.get(path);
    if (!url) throw new Error(`Missing download version: ${path}`);
    if (cache) {
      const saved = await cache.match(url);
      if (saved) return saved;
    }
    const downloaded = await fetch(url);
    if (!downloaded.ok) throw new Error(`${path}: HTTP ${downloaded.status}`);
    if (!cache) return downloaded;
    try {
      // Consume the network response into storage before reading it back.
      // Avoid cloning a huge stream and buffering a second copy in memory.
      await cache.put(url, downloaded);
      const saved = await cache.match(url);
      if (!saved) throw new Error('Stored download was evicted');
      return saved;
    } catch (error) {
      report('download-cache-unavailable', String(error));
      cache = undefined;
      return fetch(url);
    }
  };
}
