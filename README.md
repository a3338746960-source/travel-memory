# 旅行回顾库

一个轻量级旅行回顾网页，用照片 GPS、每日路线和点位照片，把旅程整理成可以慢慢翻看的记忆地图。

> **隐私说明**：本公开仓库只包含代码。个人旅行照片、轨迹数据、票据和笔记仅保存在本地（`trips/`、`public/data/`、`public/assets/`、`data/manual-notes/` 均已加入 `.gitignore`），不会随仓库公开。

## 当前结构

- 默认首页：旅行列表（卡片式浏览）
- 点击旅行卡片进入回顾页（地图、时间线、照片墙）
- 云端资源托管在腾讯 COS，本地不保存原始照片/视频
- 旅行数据与照片仅保存在本地，不在本仓库中

## 快速启动

```bash
npm run dev
```

打开 `http://localhost:5173`：
- 首页显示旅行列表
- 点击卡片进入 `?trip=2025-japan` 查看回顾

## 目录结构

```
trips/
  # 本地旅行数据（照片、轨迹、笔记），不入库
  index.json                    # 旅行列表索引
  2025-japan/
    trip-config.json            # 当前旅行配置
    data/
      trip-data.json            # 旅行数据（地点、媒体、路线）
      poi-anchors.json          # 当前旅行专属 POI 锚点
      geocoding-cache.json      # 地理编码缓存
public/
  data/trip-data.json           # 兼容副本（本地生成，不入库）
  raw/                          # 原始素材（票据、媒体），不入库
src/
  app.js                        # 前端入口（路由 + 渲染）
  styles.css                    # 样式
scripts/
  import-trip.mjs               # 统一导入入口（扫描、生成、上传、清理）
  generate-index.mjs            # 素材扫描与数据生成
  upload-cos.mjs                # 上传到腾讯 COS
  rewrite-paths.mjs             # 路径改写为云端相对路径
  check-cloud-assets.mjs        # 云端资源检查
```

## 云端资源

预览图和视频封面已上传腾讯 COS：
```
https://travel-memory-assets-1437597724.cos.ap-beijing.myqcloud.com/trips/2025-japan/
├── data/trip-data.json
├── generated/previews/
└── generated/video-posters/
```

前端自动通过 `assetBaseUrl` + 相对路径拼接云端 URL。

## 订单事件

`sourceDirs.receipts` 目录下的订单/票据文件（PDF、图片）会被自动解析为结构化事件，写入 `trip-data.json` 顶层 `events` 数组。

- 订单分为 `lodging`（住宿）、`transport`（交通）、`ticket`（门票）、`other`（其他）
- 订单不会生成地图点，不会进入照片墙
- 每日页面通过 `day.events` 关联展示事件
- 解析结果包含 `rawText`，删除原始文件后仍可查看事件详情
- 确认解析无误后可通过 `--cleanup-raw` 删除原件

## 新增旅行流程

1. 新建旅行目录：

```text
trips/<trip-id>/
trips/<trip-id>/data/
```

2. 新建 `trips/<trip-id>/trip-config.json`，填写旅行配置：

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

地点名默认由真实 GPS、联网反查和 `geocoding-cache.json` 生成。`poiAnchors` 是可选人工增强，可以是 JSON 文件路径或内联数组；没有 POI 时也会使用反查结果里的街区、车站、道路或区域名。`cityRegions` 也支持 `bounds: [minLat, maxLat, minLng, maxLng]`，但建议新配置统一使用 `latMin/latMax/lngMin/lngMax`，更直观。

地点反查规则：

- 只有带真实 GPS 的照片/视频会生成地图点。
- 非 `--reverse-geocode` 模式只读取本地缓存，不发联网请求。
- 使用 `--reverse-geocode` 时才请求 OpenStreetMap/Nominatim，并把结果写入该旅行的 `geocoding-cache.json`。
- 订单事件、文本地址和手动备注不会生成地图点。

3. 导入该旅行的预览图、视频封面、订单或备注。前端运行只依赖生成后的预览图、封面和 `trip-data.json`，不依赖原始照片/视频。

4. 导入素材并生成数据（预览图、视频封面自动输出到 `trips/<trip-id>/generated/`）：

```bash
npm run import:trip -- --trip <trip-id>
```

生成步骤会自动创建 `trips/<trip-id>/data/` 和 `trips/<trip-id>/generated/` 目录，并更新 `trips/index.json`。

如果原始素材已经删除，但需要用现有 `trip-data.json` 重新补配置字段或应用备注：

```bash
npm run import:trip -- --trip <trip-id> --reuse-media
```

5. 上传预览图、视频封面和数据到 COS。可以在导入时一并完成：

```bash
npm run import:trip -- --trip <trip-id> --upload
```

或单独上传：

```bash
npm run upload:cos -- --trip <trip-id>
```

6. 打开首页确认新旅行出现，再进入 `?trip=<trip-id>` 验证地图、时间线和照片墙。

7. 确认无误后，如需清理原始素材释放空间，必须搭配 `--upload` 使用：

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

## npm 命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动本地开发服务器 |
| `npm run import:trip -- --trip <trip-id>` | 导入素材、生成数据 |
| `npm run import:trip -- --trip <trip-id> --upload` | 导入并上传到 COS |
| `npm run import:trip -- --trip <trip-id> --upload --cleanup-raw` | 导入、上传并清理原始素材 |
| `npm run import:media` | 导入默认旅行（2025-japan） |
| `npm run notes:apply` | 重新应用旅行笔记 |
| `npm run check` | 检查数据完整性 |
| `npm run upload:cos` | 单独上传资源到腾讯 COS |
| `npm run rewrite:paths` | 改写路径为云端格式 |
| `npm run cloud:check` | 检查云端资源可访问性 |

> **注意**：默认旅行（2025-japan）的预览图输出到 `public/generated/` 以保持兼容。新旅行的预览图默认输出到 `trips/<trip-id>/generated/`，无需手动配置。

## 环境配置

复制 `.env.example` 为 `.env`，填入腾讯云 COS 凭据：

```
COS_SECRET_ID=你的SecretId
COS_SECRET_KEY=你的SecretKey
COS_BUCKET=travel-memory-assets-1437597724
COS_REGION=ap-beijing
COS_APP_ID=1437597724
```

密钥使用 CAM 子账号，不要使用主账号。
