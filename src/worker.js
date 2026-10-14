const largeFiles = new Map([
  ["/native-build/diagnostic-O1.wasm", "application/wasm"],
  ["/web-game/data.win", "application/octet-stream"],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;

    if (largeFiles.has(url.pathname)) {
      if (!["GET", "HEAD"].includes(request.method)) {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }
      const object =
        request.method === "HEAD"
          ? await env.GAME_ASSETS.head(url.pathname.slice(1))
          : await env.GAME_ASSETS.get(url.pathname.slice(1));
      if (!object) {
        response = new Response("Game file not found", { status: 404 });
      } else {
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("Content-Type", largeFiles.get(url.pathname));
        headers.set("Content-Length", String(object.size));
        headers.set("ETag", object.httpEtag);
        headers.set("Cache-Control", "no-cache");
        response = new Response(
          request.method === "HEAD" ? null : object.body,
          { headers },
        );
      }
    } else {
      response = await env.ASSETS.fetch(request);
    }

    const headers = new Headers(response.headers);
    if (response.ok && url.searchParams.has("v")) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set(
      "Link",
      '<https://github.com/dennisimoo/forager-wasm/tree/codex/forager-4.1.9>; rel="source"',
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
