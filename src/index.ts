const SERVICE_VERSION = "v1";
const INSIGHTFLARE_MAP_RESOURCE_PREFIX = "/api/public/resources/map";
const CLIENT_HEADER = "x-insightflare-client";
const CLIENT_MARKER = "insightflare-backend-v1";
const VERSION_HEADER = "x-insightflare-version";
const COMMIT_HEADER = "x-insightflare-commit";
const HOST_HEADER = "x-insightflare-host";
const PROTOCOL_HEADER = "x-insightflare-protocol";
const LOCALE_HEADER = "x-insightflare-locale";
const LOCALE_QUERY_PARAM = "if_locale";

const CARTO_STYLE_URLS = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
} as const;

const CARTO_TILE_JSON_URL =
  "https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json";

const CARTO_MVT_HOSTS = [
  "tiles-a.basemaps.cartocdn.com",
  "tiles-b.basemaps.cartocdn.com",
  "tiles-c.basemaps.cartocdn.com",
  "tiles-d.basemaps.cartocdn.com",
] as const;

const DARK_PAINT_OVERRIDES = [
  ["background", "background-color", "#090909"],
  ["landcover", "fill-color", "#090909"],
  ["park_national_park", "fill-color", "#090909"],
  ["park_nature_reserve", "fill-color", "#090909"],
  ["landuse_residential", "fill-color", "#090909"],
  ["landuse", "fill-color", "#090909"],
  ["water", "fill-color", "#262626"],
  ["waterway", "line-color", "#262626"],
  ["boundary_country_outline", "line-color", "#262626"],
  ["boundary_country_inner", "line-color", "#3b3b3b"],
  ["watername_ocean", "text-color", "#444444"],
  ["place_country_1", "text-color", "#4a4a4a"],
  ["place_country_2", "text-color", "#4a4a4a"],
  ["place_continent", "text-color", "#444444"],
] as const;

const MAX_JSON_BYTES = 4 * 1024 * 1024;

type Theme = keyof typeof CARTO_STYLE_URLS;
type MapLocale = "en" | "zh" | "ja";
type JsonObject = Record<string, unknown>;

type CacheProfile = {
  edgeTtl: number;
  browserTtl: number;
  staleWhileRevalidate: number;
  staleIfError: number;
  contentType: string;
  defaultAccept: string;
};

const CACHE_PROFILES = {
  style: {
    edgeTtl: 60 * 60,
    browserTtl: 5 * 60,
    staleWhileRevalidate: 60 * 60,
    staleIfError: 24 * 60 * 60,
    contentType: "application/json; charset=utf-8",
    defaultAccept: "application/json",
  },
  tileJson: {
    edgeTtl: 60 * 60,
    browserTtl: 5 * 60,
    staleWhileRevalidate: 60 * 60,
    staleIfError: 24 * 60 * 60,
    contentType: "application/json; charset=utf-8",
    defaultAccept: "application/json",
  },
  vectorTile: {
    edgeTtl: 7 * 24 * 60 * 60,
    browserTtl: 24 * 60 * 60,
    staleWhileRevalidate: 24 * 60 * 60,
    staleIfError: 30 * 24 * 60 * 60,
    contentType: "application/vnd.mapbox-vector-tile",
    defaultAccept: "application/vnd.mapbox-vector-tile,application/x-protobuf",
  },
  font: {
    edgeTtl: 30 * 24 * 60 * 60,
    browserTtl: 7 * 24 * 60 * 60,
    staleWhileRevalidate: 24 * 60 * 60,
    staleIfError: 30 * 24 * 60 * 60,
    contentType: "application/x-protobuf",
    defaultAccept: "application/x-protobuf,application/octet-stream",
  },
  sprite: {
    edgeTtl: 30 * 24 * 60 * 60,
    browserTtl: 7 * 24 * 60 * 60,
    staleWhileRevalidate: 24 * 60 * 60,
    staleIfError: 30 * 24 * 60 * 60,
    contentType: "application/octet-stream",
    defaultAccept: "*/*",
  },
} as const satisfies Record<string, CacheProfile>;

type MapRelayEnv = Env & {
  CARTO_BASEMAP_KEY?: string;
};

type RequestMetadata = {
  client: string | null;
  version: string | null;
  commit: string | null;
  host: string | null;
  protocol: "http" | "https";
  locale: MapLocale | null;
  requestHost: string;
};

type UpstreamResult = {
  response: Response;
  host: string;
};

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function getBoundedHeader(
  request: Request,
  name: string,
  maxLength = 256,
): string | null {
  const value = request.headers.get(name)?.trim() || "";
  if (!value) return null;
  if (value.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function parseLocale(value: string | null | undefined): MapLocale | null {
  return value === "en" || value === "zh" || value === "ja" ? value : null;
}

function readRequestMetadata(request: Request): RequestMetadata {
  return {
    client: getBoundedHeader(request, CLIENT_HEADER, 64),
    version: getBoundedHeader(request, VERSION_HEADER, 128),
    commit: getBoundedHeader(request, COMMIT_HEADER, 128),
    host: getBoundedHeader(request, HOST_HEADER, 255),
    protocol:
      getBoundedHeader(request, PROTOCOL_HEADER, 8) === "http"
        ? "http"
        : "https",
    locale: parseLocale(getBoundedHeader(request, LOCALE_HEADER, 8)),
    requestHost: request.headers.get("host") || new URL(request.url).host,
  };
}

function logRequest(
  request: Request,
  metadata: RequestMetadata,
  fields: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      event: "maprelay.request",
      method: request.method,
      path: new URL(request.url).pathname,
      headers: {
        [CLIENT_HEADER]: metadata.client,
        [VERSION_HEADER]: metadata.version,
        [COMMIT_HEADER]: metadata.commit,
        [HOST_HEADER]: metadata.host,
        [PROTOCOL_HEADER]: metadata.protocol,
        [LOCALE_HEADER]: metadata.locale,
        host: metadata.requestHost,
      },
      ...fields,
    }),
  );
}

function addCARTOKey(rawUrl: string, key: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("key", key);
  return url.toString();
}

function getCARTOKey(env: MapRelayEnv): string | null {
  const key = env.CARTO_BASEMAP_KEY?.trim();
  return key && key.length <= 512 ? key : null;
}

function getCacheHeaders(profile: CacheProfile): Headers {
  const headers = new Headers();
  headers.set(
    "cache-control",
    [
      "public",
      `max-age=${profile.browserTtl}`,
      `stale-while-revalidate=${profile.staleWhileRevalidate}`,
      `stale-if-error=${profile.staleIfError}`,
    ].join(", "),
  );
  headers.set(
    "cloudflare-cdn-cache-control",
    [
      `max-age=${profile.edgeTtl}`,
      `stale-while-revalidate=${profile.staleWhileRevalidate}`,
      `stale-if-error=${profile.staleIfError}`,
    ].join(", "),
  );
  headers.set("vary", "Accept-Encoding");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function getUpstreamCacheOptions(
  profile: CacheProfile,
): RequestInitCfProperties {
  return {
    cacheEverything: true,
    cacheTtlByStatus: {
      "200-299": profile.edgeTtl,
      "404": 60,
      "429": 30,
      "500-599": 0,
    },
  };
}

async function fetchCARTO(
  rawUrl: string,
  key: string,
  profile: CacheProfile,
): Promise<Response> {
  return fetch(addCARTOKey(rawUrl, key), {
    headers: {
      accept: profile.defaultAccept,
    },
    cf: getUpstreamCacheOptions(profile),
  });
}

async function fetchCARTOWithFallback(
  rawUrls: readonly string[],
  key: string,
  profile: CacheProfile,
): Promise<UpstreamResult> {
  let lastResponse: Response | null = null;
  let lastHost = "";

  for (const rawUrl of rawUrls) {
    const host = new URL(rawUrl).host;
    lastHost = host;
    try {
      const response = await fetchCARTO(rawUrl, key, profile);
      if (response.ok || rawUrl === rawUrls[rawUrls.length - 1]) {
        return { response, host };
      }
      await response.body?.cancel();
      lastResponse = response;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "maprelay.upstream_error",
          host,
          error: error instanceof Error ? error.message : "fetch_failed",
        }),
      );
    }
  }

  return {
    response: lastResponse || new Response(null, { status: 502 }),
    host: lastHost,
  };
}

async function readTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") || "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("upstream_json_too_large");
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("upstream_json_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function getInsightFlareOrigin(metadata: RequestMetadata): string | null {
  if (!metadata.host) return null;

  try {
    const url = new URL(`${metadata.protocol}://${metadata.host}`);
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function insightFlareResourceUrl(origin: string, path: string): string {
  return `${origin}${path}`;
}

function insightFlareStyleSourceUrl(origin: string): string {
  return insightFlareResourceUrl(
    origin,
    `${INSIGHTFLARE_MAP_RESOURCE_PREFIX}/v1/sources/carto.streets/v1/tiles.json`,
  );
}

function insightFlareSpriteUrl(origin: string, theme: Theme): string {
  return insightFlareResourceUrl(
    origin,
    `${INSIGHTFLARE_MAP_RESOURCE_PREFIX}/v1/sprites/${theme}/sprite`,
  );
}

function insightFlareGlyphUrl(origin: string): string {
  return insightFlareResourceUrl(
    origin,
    `${INSIGHTFLARE_MAP_RESOURCE_PREFIX}/v1/fonts/{fontstack}/{range}.pbf`,
  );
}

function insightFlareTileUrl(origin: string): string {
  return insightFlareResourceUrl(
    origin,
    `${INSIGHTFLARE_MAP_RESOURCE_PREFIX}/v1/tiles/carto.streets/v1/{z}/{x}/{y}.mvt`,
  );
}

function localizedNameExpression(locale: MapLocale): unknown[] {
  const localizedFields =
    locale === "zh"
      ? ["name:zh-Hans", "name:zh"]
      : [locale === "en" ? "name_en" : `name:${locale}`];
  return [
    "coalesce",
    ...localizedFields.map((field) => ["get", field]),
    ["get", "name_en"],
    ["get", "name_int"],
    ["get", "name"],
  ];
}

function applyLocalizedTextFields(style: JsonObject, locale: MapLocale): void {
  const layers = style.layers;
  if (!Array.isArray(layers)) return;

  const localizableSourceLayers = new Set([
    "waterway",
    "water_name",
    "place",
    "poi",
    "transportation_name",
  ]);
  const textField = localizedNameExpression(locale);

  for (const candidate of layers) {
    const layer = asObject(candidate);
    const sourceLayer = layer?.["source-layer"];
    if (!layer || typeof sourceLayer !== "string") continue;
    if (!localizableSourceLayers.has(sourceLayer)) continue;

    const layout = asObject(layer.layout);
    if (!layout || !Object.prototype.hasOwnProperty.call(layout, "text-field")) {
      continue;
    }

    layout["text-field"] = textField;
    layer.layout = layout;
  }
}

function applyPaintOverrides(
  style: JsonObject,
  theme: Theme,
): void {
  const layers = style.layers;
  if (!Array.isArray(layers)) return;

  const overrides = theme === "dark" ? DARK_PAINT_OVERRIDES : [];

  for (const [layerId, property, color] of overrides) {
    const layer = layers.find((candidate) => {
      const object = asObject(candidate);
      return object?.id === layerId;
    });
    const layerObject = asObject(layer);
    if (!layerObject) continue;
    const paint = asObject(layerObject.paint) || {};
    paint[property] = color;
    layerObject.paint = paint;
  }
}

function transformStyle(
  value: unknown,
  theme: Theme,
  locale: MapLocale,
  insightFlareOrigin: string,
): JsonObject {
  const style = asObject(value);
  if (!style) throw new Error("invalid_style_json");

  const sources = asObject(style.sources);
  const cartoSource = sources ? asObject(sources.carto) : null;
  if (cartoSource) {
    if (typeof cartoSource.url === "string") {
      cartoSource.url = insightFlareStyleSourceUrl(insightFlareOrigin);
    }
    if (Array.isArray(cartoSource.tiles)) {
      cartoSource.tiles = [insightFlareTileUrl(insightFlareOrigin)];
    }
  }

  style.sprite = insightFlareSpriteUrl(insightFlareOrigin, theme);
  style.glyphs = insightFlareGlyphUrl(insightFlareOrigin);
  applyLocalizedTextFields(style, locale);
  applyPaintOverrides(style, theme);
  return style;
}

function transformTileJson(
  value: unknown,
  insightFlareOrigin: string,
): JsonObject {
  const tileJson = asObject(value);
  if (!tileJson) throw new Error("invalid_tile_json");
  tileJson.tiles = [insightFlareTileUrl(insightFlareOrigin)];
  return tileJson;
}

async function hashBody(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const bytes = new Uint8Array(digest);
  return `\"${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}\"`;
}

async function jsonResponse(
  value: unknown,
  profile: CacheProfile,
): Promise<Response> {
  const body = JSON.stringify(value);
  const headers = getCacheHeaders(profile);
  headers.set("content-type", profile.contentType);
  headers.set("etag", await hashBody(body));

  return new Response(body, { status: 200, headers });
}

function binaryResponse(upstream: Response, profile: CacheProfile): Response {
  const headers = getCacheHeaders(profile);
  headers.set(
    "content-type",
    upstream.headers.get("content-type") || profile.contentType,
  );

  const upstreamEtag = upstream.headers.get("etag");
  if (upstreamEtag) headers.set("etag", upstreamEtag);
  const lastModified = upstream.headers.get("last-modified");
  if (lastModified) headers.set("last-modified", lastModified);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function transformedJsonResponse(
  upstream: Response,
  profile: CacheProfile,
  transform: (value: unknown) => JsonObject,
): Promise<Response> {
  try {
    const text = await readTextWithLimit(upstream, MAX_JSON_BYTES);
    const value = JSON.parse(text) as unknown;
    return jsonResponse(transform(value), profile);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "maprelay.transform_error",
        error: error instanceof Error ? error.message : "invalid_json",
      }),
    );
    return jsonError(
      502,
      "invalid_upstream_json",
      "The map metadata is invalid.",
    );
  }
}

function getTileUrls(z: string, x: string, y: string): string[] {
  return CARTO_MVT_HOSTS.map(
    (host) => `https://${host}/vectortiles/carto.streets/v1/${z}/${x}/${y}.mvt`,
  );
}

function classifyResource(pathname: string): string {
  if (/^\/v1\/styles\/(light|dark)\/style\.json$/.test(pathname)) {
    return "style";
  }
  if (pathname === "/v1/sources/carto.streets/v1/tiles.json") {
    return "tilejson";
  }
  if (/^\/v1\/tiles\/carto\.streets\/v1\/\d+\/\d+\/\d+\.mvt$/.test(pathname)) {
    return "vector_tile";
  }
  if (/^\/v1\/fonts\/[^/]+\/[^/]+\.pbf$/.test(pathname)) return "font";
  if (
    /^\/v1\/sprites\/(light|dark)\/sprite(@2x)?\.(json|png)$/.test(pathname)
  ) {
    return "sprite";
  }
  return "unknown";
}

function parseTheme(value: string): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded || null;
  } catch {
    return null;
  }
}

async function handleMapRequest(
  request: Request,
  env: MapRelayEnv,
  metadata: RequestMetadata,
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const resource = classifyResource(pathname);
  const key = getCARTOKey(env);
  const insightFlareOrigin = getInsightFlareOrigin(metadata);
  const locale = parseLocale(url.searchParams.get(LOCALE_QUERY_PARAM)) ?? "en";

  if (!insightFlareOrigin) {
    return jsonError(
      400,
      "invalid_insightflare_host",
      "A valid InsightFlare host is required.",
    );
  }

  if (!key) {
    return jsonError(
      503,
      "carto_key_not_configured",
      "CARTO_BASEMAP_KEY is not configured.",
    );
  }

  if (resource === "style") {
    const match = /^\/v1\/styles\/(light|dark)\/style\.json$/.exec(pathname);
    const theme = match ? parseTheme(match[1]) : null;
    if (!theme) return jsonError(404, "not_found", "Map resource not found.");

    const profile = CACHE_PROFILES.style;
    const upstream = await fetchCARTO(CARTO_STYLE_URLS[theme], key, profile);
    if (!upstream.ok) {
      return jsonError(
        502,
        "upstream_unavailable",
        "CARTO style is unavailable.",
      );
    }
    const response = await transformedJsonResponse(upstream, profile, (value) =>
      transformStyle(value, theme, locale, insightFlareOrigin),
    );
    logRequest(request, metadata, {
      resource,
      theme,
      locale,
      status: response.status,
      upstreamCache: upstream.headers.get("cf-cache-status"),
    });
    return response;
  }

  if (resource === "tilejson") {
    const profile = CACHE_PROFILES.tileJson;
    const upstream = await fetchCARTO(CARTO_TILE_JSON_URL, key, profile);
    if (!upstream.ok) {
      return jsonError(
        502,
        "upstream_unavailable",
        "CARTO tile metadata is unavailable.",
      );
    }
    const response = await transformedJsonResponse(upstream, profile, (value) =>
      transformTileJson(value, insightFlareOrigin),
    );
    logRequest(request, metadata, {
      resource,
      status: response.status,
      upstreamCache: upstream.headers.get("cf-cache-status"),
    });
    return response;
  }

  if (resource === "vector_tile") {
    const match =
      /^\/v1\/tiles\/carto\.streets\/v1\/(\d+)\/(\d+)\/(\d+)\.mvt$/.exec(
        pathname,
      );
    if (!match) return jsonError(404, "not_found", "Map resource not found.");

    const [, z, x, y] = match;
    const zoom = Number(z);
    const tileX = Number(x);
    const tileY = Number(y);
    const max = 2 ** zoom;
    if (
      !Number.isSafeInteger(zoom) ||
      zoom < 0 ||
      zoom > 20 ||
      !Number.isSafeInteger(tileX) ||
      tileX < 0 ||
      tileX >= max ||
      !Number.isSafeInteger(tileY) ||
      tileY < 0 ||
      tileY >= max
    ) {
      return jsonError(
        400,
        "invalid_tile_coordinate",
        "Invalid tile coordinate.",
      );
    }

    const normalizedX = ((tileX % max) + max) % max;
    const rawUrls = getTileUrls(z, String(normalizedX), y);
    const result = await fetchCARTOWithFallback(
      rawUrls,
      key,
      CACHE_PROFILES.vectorTile,
    );
    const response = result.response.ok
      ? binaryResponse(result.response, CACHE_PROFILES.vectorTile)
      : jsonError(
          502,
          "upstream_unavailable",
          "CARTO vector tile is unavailable.",
        );
    logRequest(request, metadata, {
      resource,
      z,
      x: normalizedX,
      y,
      status: response.status,
      upstreamHost: result.host,
      upstreamStatus: result.response.status,
      upstreamCache: result.response.headers.get("cf-cache-status"),
    });
    return response;
  }

  if (resource === "font") {
    const match = /^\/v1\/fonts\/([^/]+)\/([^/]+)\.pbf$/.exec(pathname);
    if (!match) return jsonError(404, "not_found", "Map resource not found.");

    const fontstack = decodePathSegment(match[1]);
    const range = decodePathSegment(match[2]);
    if (!fontstack || !range || !/^\d+-\d+$/.test(range)) {
      return jsonError(400, "invalid_font_request", "Invalid font request.");
    }

    const rawUrl = `https://tiles.basemaps.cartocdn.com/fonts/${encodeURIComponent(
      fontstack,
    )}/${range}.pbf`;
    const result = await fetchCARTOWithFallback(
      [rawUrl],
      key,
      CACHE_PROFILES.font,
    );
    const response = result.response.ok
      ? binaryResponse(result.response, CACHE_PROFILES.font)
      : jsonError(502, "upstream_unavailable", "CARTO font is unavailable.");
    logRequest(request, metadata, {
      resource,
      fontstack,
      range,
      status: response.status,
      upstreamHost: result.host,
      upstreamStatus: result.response.status,
      upstreamCache: result.response.headers.get("cf-cache-status"),
    });
    return response;
  }

  if (resource === "sprite") {
    const match =
      /^\/v1\/sprites\/(light|dark)\/sprite(@2x)?\.(json|png)$/.exec(pathname);
    const theme = match ? parseTheme(match[1]) : null;
    const scale = match?.[2] || "";
    const extension = match?.[3];
    if (!theme || !extension) {
      return jsonError(404, "not_found", "Map resource not found.");
    }

    const rawUrl = `https://tiles.basemaps.cartocdn.com/gl/${
      theme === "light" ? "positron" : "dark-matter"
    }-gl-style/sprite${scale}.${extension}`;
    const result = await fetchCARTOWithFallback(
      [rawUrl],
      key,
      CACHE_PROFILES.sprite,
    );
    const response = result.response.ok
      ? binaryResponse(result.response, CACHE_PROFILES.sprite)
      : jsonError(502, "upstream_unavailable", "CARTO sprite is unavailable.");
    logRequest(request, metadata, {
      resource,
      theme,
      scale: scale || "1x",
      extension,
      status: response.status,
      upstreamHost: result.host,
      upstreamStatus: result.response.status,
      upstreamCache: result.response.headers.get("cf-cache-status"),
    });
    return response;
  }

  return jsonError(404, "not_found", "Map resource not found.");
}

function healthResponse(env: MapRelayEnv): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "map-relay",
      version: SERVICE_VERSION,
      cartoKeyConfigured: Boolean(getCARTOKey(env)),
      resources: [
        "/v1/styles/{light|dark}/style.json",
        "/v1/sources/carto.streets/v1/tiles.json",
        "/v1/tiles/carto.streets/v1/{z}/{x}/{y}.mvt",
        "/v1/fonts/{fontstack}/{range}.pbf",
        "/v1/sprites/{light|dark}/sprite[\u00402x].{json|png}",
      ],
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function fetchHandler(
  request: Request,
  env: MapRelayEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/health") {
    return healthResponse(env);
  }

  if (request.method !== "GET") {
    return jsonError(405, "method_not_allowed", "Only GET is supported.");
  }

  const metadata = readRequestMetadata(request);
  logRequest(request, metadata, {
    resource: classifyResource(url.pathname),
    phase: "received",
  });

  if (metadata.client !== CLIENT_MARKER) {
    return jsonError(
      403,
      "missing_client_marker",
      "The InsightFlare backend marker is required.",
    );
  }

  if (!metadata.version || !metadata.commit || !metadata.host) {
    return jsonError(
      400,
      "missing_insightflare_metadata",
      "InsightFlare version, commit, and host headers are required.",
    );
  }

  return handleMapRequest(request, env, metadata);
}

export default {
  fetch: fetchHandler,
} satisfies ExportedHandler<MapRelayEnv>;
