function getRequiredQuery(name) {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (!value) {
    alert(`Missing query param: ${name}`);
    window.location.href = "/";
    throw new Error(`Missing query param: ${name}`);
  }
  return value;
}

function toYouTubeEmbedUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== "string") return "";

  function buildEmbedUrl(id) {
    const origin = window.location.origin;
    const params = new URLSearchParams({
      rel: "0",
      modestbranding: "1",
      playsinline: "1",
      iv_load_policy: "3",
      fs: "0",
      disablekb: "1",
      enablejsapi: "1",
      origin,
    });
    return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
  }

  function cleanVideoId(candidate) {
    if (!candidate) return "";
    const value = String(candidate).trim();
    // YouTube video IDs are 11 chars using URL-safe chars.
    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
    return "";
  }

  try {
    const parsed = new URL(inputUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

    // youtu.be/<id>
    if (host === "youtu.be") {
      const id = cleanVideoId(parsed.pathname.split("/").filter(Boolean)[0]);
      if (id) return buildEmbedUrl(id);
    }

    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      // /watch?v=<id>
      const fromV = cleanVideoId(parsed.searchParams.get("v"));
      if (fromV) return buildEmbedUrl(fromV);

      // /live/<id>, /shorts/<id>, /embed/<id>
      const parts = parsed.pathname.split("/").filter(Boolean);
      const markerIndex = parts.findIndex(
        (x) => x === "live" || x === "shorts" || x === "embed"
      );
      if (markerIndex !== -1) {
        const fromPath = cleanVideoId(parts[markerIndex + 1]);
        if (fromPath) return buildEmbedUrl(fromPath);
      }
    }

    // If user pasted bare video ID.
    const bare = cleanVideoId(inputUrl);
    if (bare) return buildEmbedUrl(bare);

    return "";
  } catch (_err) {
    const bare = cleanVideoId(inputUrl);
    if (bare) return buildEmbedUrl(bare);
    return "";
  }
}
