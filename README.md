# 旅行回顾库 Travel Memory

一个轻量级旅行回顾网页：用照片 GPS、每日路线和点位照片，把旅程整理成可以慢慢翻看的记忆地图。

> **隐私说明**：本公开仓库只包含代码。个人旅行照片、轨迹数据、票据和笔记仅保存在本地（`trips/`、`public/data/`、`public/assets/`、`data/manual-notes/` 均已加入 `.gitignore`），不会随仓库公开。

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [纯本地模式（无需 COS）](#纯本地模式无需-cos)
- [目录结构](#目录结构)
- [添加一次旅行](#添加一次旅行)
- [订单事件](#订单事件)
- [命令参考](#命令参考)
- [数据与隐私](#数据与隐私)
- [环境配置](#环境配置)

## 功能特性

- 首页旅行列表：卡片式浏览
- 旅行回顾页：地图、时间线、照片墙
- 云端资源托管在腾讯 COS，本地不保存原始照片/视频
- 订单/票据（PDF、图片）自动解析为结构化事件
- 照片 GPS 逆地理编码自动生成地点名

## 快速开始

```bash
npm install
npm run dev            # 启动本地开发服务器
```

打开 `http://localhost:5173`：

- 首页显示旅行列表
- 点击卡片进入 `?trip=<trip-id>` 查看回顾

> 注意：本仓库不含旅行数据。本地放置 `trips/<trip-id>/` 数据后即可正常浏览；`.env` 仅在需要上传腾讯 COS 时配置（见「环境配置」）。

## 纯本地模式（无需 COS）

不配置腾讯云也能完整使用：导入素材、生成数据、本地预览全部在本地完成。

- 默认 `assetBaseUrl` 指向本地生成目录：`./trips/<trip-id>/generated/`
- 导入时**不带** `--upload`，素材路径保持本地相对路径，无需 `.env`
- 前端直接通过本地服务器访问 `trips/` 下的预览图和数据

```bash
npm install
npm run dev
npm run import:trip -- --trip <trip-id>
# 打开 http://localhost:5173/?trip=<trip-id>
```

只有需要把资源托管到腾讯 COS（例如部署到公网）时才需要云端配置：

1. 复制 `.env.example` 为 `.env` 并填写 COS 凭据
2. 把 `trip-config.json` 的 `assetBaseUrl` 改为云端地址，如 `https://<bucket>.cos.<region>.myqcloud.com/trips/<trip-id>/`
3. 导入时加 `--upload` 上传资源；如需把 `trip-data.json` 中的路径改写为云端相对路径，执行 `npm run rewrite:paths`

## 目录结构

```text
server.mjs                     # 本地服务端（素材上传与接口）
index.html                     # 首页入口
src/
  app.js                       # 前端入口（路由 + 渲染）
  styles.css                   # 样式
scripts/
  import-trip.mjs              # 统一导入入口（扫描、生成、上传、清理）
  generate-index.mjs           # 素材扫描与数据生成
  upload-cos.mjs               # 上传到腾讯 COS
  rewrite-paths.mjs            # 路径改写为云端相对路径
  check-cloud-assets.mjs       # 云端资源检查
  compress-previews.mjs        # 预览图压缩
  ...                          # 其余辅助脚本
public/
  data/trip-data.json          # 兼容副本（本地生成，不入库）
  raw/                         # 原始素材（票据、媒体），不入库
trips/                         # 本地旅行数据（照片、轨迹、笔记），不入库
  <trip-id>/
    trip-config.json           # 旅行配置
    data/                      # trip-data.json、poi-anchors.json、geocoding-cache.json
    generated/                 # 预览图、视频封面
```

## 添加一次旅行

### 1. 新建旅行目录与配置

```text
trips/<trip-id>/
trips/<trip-id>/data/
```

新建 `trips/<trip-id>/trip-config.json`：

```json
{
  "id": "<trip-id>",
  "title": "旅行标题",
  "subtitle": "城市或路线摘要",
  "dateRange": ["2026-01-01", "2026-01-07"],
  "timezoneOffsetHours": 8,
  "defaultMapCenter": [39.9042, 116.4074],
  "defaultPlaceName": "旅行地点",
  "geocodeLanguages": "zh-CN,zh,en",
  "cover": "./public/assets/example-cover.jpg",
  "assetBaseUrl": "https://你的COS域名/trips/<trip-id>/",
  "sourceDirs": {
    "media": "public/raw/iphone-media",
    "receipts": "public/raw/receipts",
    "vlog": "public/raw/vlog"
  },
  "outputPaths": {
    "tripData": "trips/<trip-id>/data/trip-data.json",
    "compatTripData": "public/data/trip-data.json",
    "geocodingCache": "trips/<trip-id>/data/geocoding-cache.json",
    "notes": "data/manual-notes/trip-notes.json"
  },
  "cityRegions": [
    {
      "name": "城市名",
      "latMin": 39.4,
      "latMax": 40.5,
      "lngMin": 115.7,
      "lngMax": 117.4
    }
  ]
}
```

地点名默认由真实 GPS、联网反查和 `geocoding-cache.json` 生成。`poiAnchors` 是可选的人工增强，可以是 JSON 文件路径或内联数组；没有 POI 时也会使用反查结果里的街区、车站、道路或区域名。`cityRegions` 也支持 `bounds: [minLat, maxLat, minLng, maxLng]`，但建议新配置统一使用 `latMin/latMax/lngMin/lngMax`。

### 2. 导入素材并生成数据

导入该旅行的预览图、视频封面、订单或备注。前端运行只依赖生成后的预览图、封面和 `trip-data.json`，不依赖原始照片/视频。

```bash
npm run import:trip -- --trip <trip-id>
```

生成步骤会自动创建 `trips/<trip-id>/data/` 和 `trips/<trip-id>/generated/`，并更新 `trips/index.json`。

如果原始素材已删除，但需要用现有 `trip-data.json` 重新补配置字段或应用备注：

```bash
npm run import:trip -- --trip <trip-id> --reuse-media
```

### 3. 上传云端资源（可选）

纯本地预览可跳过此步；需要把资源托管到腾讯 COS 时执行：

```bash
npm run import:trip -- --trip <trip-id> --upload
```

或单独上传：

```bash
npm run upload:cos -- --trip <trip-id>
```

前端自动通过 `assetBaseUrl` + 相对路径拼接云端 URL。

### 4. 验证

打开首页确认新旅行出现，再进入 `?trip=<trip-id>` 验证地图、时间线和照片墙；也可以运行 `npm run check` 和 `npm run cloud:check`。

### 5. 清理原始素材（可选）

```bash
npm run import:trip -- --trip <trip-id> --upload --cleanup-raw
```

`--cleanup-raw` 的安全条件：

- 必须搭配 `--upload`，确保云端资源已就绪
- 上传后会自动执行云端检查（`check-cloud-assets.mjs`）
- 检查 `trip-data.json` 中不包含 `public/raw`、`imports/` 等原始路径引用
- 任何一步失败都不会删除原始素材
- 只删除 `sourceDirs` 中配置的原始目录和 `imports/<job-id>/raw/`
- 不删除 `trips/<trip-id>/data/` 和 `trips/<trip-id>/generated/`

### 地点生成规则

- 只有带真实 GPS 的照片/视频会生成地图点
- 非 `--reverse-geocode` 模式只读取本地缓存，不发联网请求
- 使用 `--reverse-geocode` 时才请求 OpenStreetMap/Nominatim，并把结果写入该旅行的 `geocoding-cache.json`
- 订单事件、文本地址和手动备注不会生成地图点

> **兼容说明**：默认旅行（2025-japan）的预览图输出到 `public/generated/` 以保持兼容；新旅行的预览图默认输出到 `trips/<trip-id>/generated/`，无需手动配置。

## 订单事件

`sourceDirs.receipts` 目录下的订单/票据文件（PDF、图片）会被自动解析为结构化事件，写入 `trip-data.json` 顶层 `events` 数组。

- 订单分为 `lodging`（住宿）、`transport`（交通）、`ticket`（门票）、`other`（其他）
- 订单不会生成地图点，不会进入照片墙
- 每日页面通过 `day.events` 关联展示事件
- 解析结果包含 `rawText`，删除原始文件后仍可查看事件详情
- 确认解析无误后可通过 `--cleanup-raw` 删除原件

## 命令参考

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动本地开发服务器（`http://localhost:5173`） |
| `npm run server` | 启动 Node 服务端 |
| `npm run import:media` | 导入默认旅行（2025-japan） |
| `npm run import:trip -- --trip <trip-id>` | 导入素材、生成数据 |
| `npm run import:trip -- --trip <trip-id> --upload` | 导入并上传到 COS |
| `npm run import:trip -- --trip <trip-id> --upload --cleanup-raw` | 导入、上传并清理原始素材 |
| `npm run notes:apply` | 重新应用旅行笔记 |
| `npm run check` | 检查数据完整性 |
| `npm run upload:cos` | 单独上传资源到腾讯 COS |
| `npm run rewrite:paths` | 改写路径为云端格式 |
| `npm run cloud:check` | 检查云端资源可访问性 |
| `npm run compress` | 压缩预览图 |

## 数据与隐私

- 本公开仓库只包含代码；`trips/`、`public/data/`、`public/assets/`、`data/manual-notes/`、`public/raw/` 均已被 `.gitignore` 排除
- `.env` 不会入库，仓库只提交 `.env.example` 占位符
- 个人旅行照片、轨迹、票据与笔记仅保存在本地

## 环境配置

仅在上传资源到腾讯 COS 时需要；纯本地预览可以跳过。复制 `.env.example` 为 `.env` 并填写：

```
COS_SECRET_ID=你的SecretId
COS_SECRET_KEY=你的SecretKey
COS_BUCKET=travel-memory-assets-1437597724
COS_REGION=ap-beijing
COS_APP_ID=1437597724
```

密钥使用 CAM 子账号，不要使用主账号。

## 开源协议

本项目使用 [MIT](LICENSE) 协议。
