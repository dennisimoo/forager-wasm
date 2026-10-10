const gamePath = "/assets/game.unx";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;

    if (url.pathname === gamePath) {
      if (!["GET", "HEAD"].includes(request.method)) {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }
      const object =
        request.method === "HEAD"
          ? await env.GAME_ASSETS.head(gamePath.slice(1))
          : await env.GAME_ASSETS.get(gamePath.slice(1));
      if (!object) {
        response = new Response("Game file not found", { status: 404 });
      } else {
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("Content-Type", "application/octet-stream");
        headers.set("Content-Length", String(object.size));
        headers.set("ETag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=31536000");
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
      '<https://github.com/dennisimoo/forager-wasm>; rel="source"',
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
