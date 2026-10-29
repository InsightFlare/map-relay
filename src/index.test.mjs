import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import mapRelay from "./index.ts";

const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previousFetch;
});

const tileTemplate =
  "https://tiles.basemaps.cartocdn.com/v/20261001-03/vectortiles/carto.streets/v2/{z}/{x}/{y}.mvt?key=example-key";
const layer = (id, sourceLayer) => ({
  id,
  type: "symbol",
  source: "protomaps",
  "source-layer": sourceLayer,
  layout: { "text-field": ["get", "name:en"] },
});
const style = {
  version: 8,
  sources: {
    protomaps: {
      type: "vector",
      tiles: [tileTemplate],
    },
  },
  layers: [
    layer("place_city", "places"),
    layer("river", "water"),
    layer("road", "roads"),
    layer("poi", "pois"),
    layer("housenumber", "buildings"),
    {
      id: "place_city_zoom",
      type: "symbol",
      source: "protomaps",
      "source-layer": "places",
      layout: {
        "text-field": [
          "step",
          ["zoom"],
          ["coalesce", ["get", "name:en"], ["get", "name"]],
          13,
          ["get", "name"],
        ],
      },
    },
  ],
};
const env = { CARTO_BASEMAP_KEY: "test-placeholder" };
function request(path, locale) {
  return new Request("https://relay.test" + path, {
    headers: {
      "x-insightflare-client": "insightflare-backend-v1",
      "x-insightflare-version": "0.7.1",
      "x-insightflare-commit": "test",
      "x-insightflare-host": "insight.example.com",
      "x-insightflare-protocol": "https",
      "x-insightflare-locale": locale,
    },
  });
}

for (const [locale, nameField] of [
  ["zh", "name:zh-Hans"],
  ["zh-tw", "name:zh-Hant"],
  ["ja", "name:ja"],
]) {
  test("modern protomaps style respects " + locale + " and proxies tiles", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify(style));
    const response = await mapRelay.fetch(
      request("/v1/styles/light/style.json?if_locale=" + locale, locale),
      env,
    );
    assert.equal(response.status, 200);
    const parsed = await response.json();
    const urls = parsed.sources.protomaps.tiles;
    assert.equal(urls.length, 1);
    assert.equal(
      urls[0],
      "https://insight.example.com/api/public/resources/map/v1/tiles/carto.streets/v2/20261001-03/{z}/{x}/{y}.mvt",
    );
    assert.equal(urls[0].includes("key="), false);
    for (const i of [0, 1, 2, 3]) {
      assert.deepEqual(parsed.layers[i].layout["text-field"][1], ["get", nameField]);
      assert.deepEqual(parsed.layers[i].layout["text-field"].at(-1), ["get", "name:en"]);
    }
    assert.deepEqual(parsed.layers[4].layout["text-field"], ["get", "name:en"]);
  });
}

test("modern proxied tiles are served with bounded coordinates", async () => {
  let upstream = "";
  globalThis.fetch = async (url) => {
    upstream = String(url);
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const path = "/v1/tiles/carto.streets/v2/20261001-03/3/6/3.mvt";
  const response = await mapRelay.fetch(request(path, "zh-tw"), env);
  assert.equal(response.status, 200);
  assert.equal(upstream.startsWith(
    "https://tiles.basemaps.cartocdn.com/v/20261001-03/vectortiles/carto.streets/v2/3/6/3.mvt"
  ), true);
  assert.equal(upstream.includes("key=test-placeholder"), true);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  const invalid = await mapRelay.fetch(
    request("/v1/tiles/carto.streets/v2/20261001-03/3/16/3.mvt", "zh-tw"),
    env,
  );
  assert.equal(invalid.status, 400);
});

test("preserves zoom-based label expressions and validates every localized map style", async () => {
  for (const theme of ["light", "dark"]) {
    for (const locale of ["en", "zh", "zh-tw", "ja"]) {
      globalThis.fetch = async () => new Response(JSON.stringify(style));
      const response = await mapRelay.fetch(
        request("/v1/styles/" + theme + "/style.json?if_locale=" + locale, locale),
        env,
      );
      assert.equal(response.status, 200);
      const localized = await response.json();
      const expression = localized.layers[5].layout["text-field"];

      // A zoom expression is legal only inside a top-level step/interpolate.
      assert.equal(expression[0], "step", theme + "/" + locale);
      assert.deepEqual(expression[1], ["zoom"]);
      assert.equal(expression[3], 13);
      if (locale === "en") {
        assert.deepEqual(expression[2], style.layers[5].layout["text-field"][2]);
        assert.deepEqual(expression[4], style.layers[5].layout["text-field"][4]);
      } else {
        assert.equal(expression[2][0], "coalesce");
        assert.equal(expression[4][0], "coalesce");
        assert.deepEqual(expression[2].at(-1), style.layers[5].layout["text-field"][2]);
        assert.deepEqual(expression[4].at(-1), style.layers[5].layout["text-field"][4]);
      }

      const errors = validateStyleMin(localized).map((error) => error.message);
      assert.deepEqual(errors, [], theme + "/" + locale + " MapLibre style validation");
    }
  }
});
