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
X-InsightFlare-Protocol: <http|https>
X-InsightFlare-Locale: <en|zh|zh-tw|ja> (optional)
```

Worker 会将这些值以结构化 JSON 写入 Workers Logs。它们不会进入 CDN 缓存键，也不会转发给 CARTO。

## 路径

```text
GET /v1/styles/light/style.json
GET /v1/styles/dark/style.json
GET /v1/sources/carto.streets/v1/tiles.json
GET /v1/tiles/carto.streets/v1/{z}/{x}/{y}.mvt
GET /v1/tiles/carto.streets/v2/{version}/{z}/{x}/{y}.mvt
GET /v1/fonts/{fontstack}/{range}.pbf
GET /v1/sprites/{light|dark}/sprite[\u00402x].{json|png}
```

样式请求可使用 `?if_locale=en|zh|zh-tw|ja`。Worker 会根据矢量样式实际存在的文字图层选择
`name:zh-Hans`（简体）、`name:zh-Hant`（繁体）或 `name:ja`（日文），
并保留 CARTO 原有文字表达式作为后备。语言只影响样式，不改动瓦片原始地名属性。

CARTO 新版 `protomaps` 数据源使用带版本号的 v2 瓦片路径，Worker 会识别版本并
改写为 InsightFlare 同源代理路径，避免把上游 Key 或外部瓦片 URL 暴露给浏览器。

Style JSON 和 TileJSON 会由本 Worker 转换成带有实例 origin 的绝对 InsightFlare `/api/public/resources/map/...` 路径，使浏览器后续请求仍然经过 InsightFlare 后端，不需要解析 CARTO JSON。这里使用绝对 URL，因为 MapLibre 会相对于页面 URL 解析样式中的资源地址。

## 缓存

Worker 使用对 CARTO 的 `fetch()` 子请求缓存：样式和 TileJSON 缓存 1 小时，矢量瓦片缓存 7 天，字体和 sprite 缓存 30 天。转换 JSON 的成本很小，因此不使用需要实例存储的 Cache API。
