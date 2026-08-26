# map-relay

无状态的 Cloudflare Worker，用于为 InsightFlare 后端代理 CARTO 矢量底图。

浏览器不应直接请求本服务。InsightFlare 实例后端应镜像下面的 `/v1` 路径，再由后端请求本 Worker。

## 配置

CARTO Key 只能作为 Cloudflare Secret 保存：

```text
npx wrangler secret put CARTO_BASEMAP_KEY
```

不要把 Key 写入 `wrangler.jsonc`、源代码、日志或请求响应。

## 后端请求头

除 `/` 和 `/health` 外，所有资源请求都必须包含：

```http
X-InsightFlare-Client: insightflare-backend-v1
X-InsightFlare-Version: <InsightFlare version>
X-InsightFlare-Commit: <commit hash>
X-InsightFlare-Host: <instance host>
```

Worker 会将这些值以结构化 JSON 写入 Workers Logs。它们不会进入 CDN 缓存键，也不会转发给 CARTO。

## 路径

```text
GET /v1/styles/light/style.json
GET /v1/styles/dark/style.json
GET /v1/sources/carto.streets/v1/tiles.json
GET /v1/tiles/carto.streets/v1/{z}/{x}/{y}.mvt
GET /v1/fonts/{fontstack}/{range}.pbf
GET /v1/sprites/{light|dark}/sprite[\u00402x].{json|png}
```

Style JSON 和 TileJSON 会由本 Worker 转换成相对路径，使 InsightFlare 后端能够直接镜像同样的路径结构，不需要解析 CARTO JSON。

## 缓存

Worker 使用对 CARTO 的 `fetch()` 子请求缓存：样式和 TileJSON 缓存 1 小时，矢量瓦片缓存 7 天，字体和 sprite 缓存 30 天。转换 JSON 的成本很小，因此不使用需要实例存储的 Cache API。
