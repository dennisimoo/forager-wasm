// Serves only the launcher and WASM runner. No game files are hosted here:
// players load their own Forager files, which stay in their browser.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = url.pathname.startsWith("/assets/")
      ? new Response("Not found", { status: 404 })
      : await env.ASSETS.fetch(request);

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
