# VidDict — 看视频学英语

> **Video + Dictation**：通过真实英语视频 + 交互式听写，全面提升英语听力与拼写能力。

VidDict 是一个全栈英语学习应用，提供 **214 个真实英语视频**（涵盖 16 个话题、3 个难度级别），配合**双语字幕播放**与**逐句听写训练**两大学习模式，让用户在真实语境中学习英语。

---

## 功能概览

### 🎬 视频库
- **214 个视频**，涵盖日常生活、商业思维、自然风光、职场经验、访谈演讲等 16 个话题
- 按**级别**（初级/中级/高级）和**话题**筛选
- 标题/描述/话题**全文搜索**
- 每页 20 个视频，支持分页浏览
- 缩略图 + 时长 + 话题标签一目了然

### 📺 视频播放 + 双语字幕
- 原生视频播放器（播放/暂停/快进/快退/音量/全屏）
- **双语字幕**（英文 + 中文对照），实时高亮当前字幕
- 字幕显示模式切换：**双语｜仅英文｜仅中文｜隐藏**
- **点击单词查词**（弹出释义卡片）
- **一键收藏生词**到个人词库（关联视频）
- 自动记录观看历史
- 字幕导出功能

### ✍️ 听写模式（核心特色）
- 逐句播放音频 → 用户听写输入 → **即时拼写检查**
- 拼写检查引擎：自动忽略标点/大小写差异，逐词标记 **正确/错误/遗漏/多余**
- 完成所有句子后显示**完整成绩单**和**错误统计**
- 听写进度自动保存到服务器，下次继续
- 支持显示中文提示

### 📊 学习记录
- **观看历史**：最近看过的 50 个视频
- **生词本**：收藏的所有单词，按时间倒序，可删除
- **听写进度**（已关联到每个视频）

### 🔐 用户系统
- 注册 / 登录 / 登出
- JWT 认证（30 天有效期）
- 每个用户独立的生词本和听写进度

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | React 19 + Vite 8 |
| 路由 | react-router-dom 7 |
| 图标 | Lucide React |
| 样式 | 纯 CSS（手写，无框架） |
| 后端 | Express 5 (CommonJS) |
| 数据库 | SQLite (via sql.js) |
| 认证 | bcryptjs + jsonwebtoken |
| 数据格式 | JSON（视频元数据 + 字幕 + 缩略图） |

---

## 快速开始

### 前置条件

- Node.js 18+
- npm

### 安装与启动

```bash
# 1. 进入项目目录
cd vidDict

# 2. 安装依赖
npm install

# 3. 启动后端 API 服务器（端口 3001）
npm run server

# 4. 新开一个终端，启动前端开发服务器（端口 5173）
npm run dev
```

然后打开浏览器访问 **http://localhost:5173**。

> 前端开发服务器已配置代理：`/api` 开头的请求自动转发到后端 3001 端口。

### 构建生产版本

```bash
npm run build
```

生成静态文件到 `dist/` 目录，可直接部署到任意静态服务器（需配合后端 API）。

### 页面路由

| 路径 | 页面 |
|---|---|
| `/` | 视频库首页 |
| `/login` | 登录/注册 |
| `/video/:id` | 视频播放 + 字幕学习 |
| `/video/:id/dictation` | 听写模式 |
| `/records` | 学习记录 |

---

## 项目结构

```
vidDict/
├── data/                        # 视频数据（非代码）
│   ├── consolidated.json        # 视频 + 字幕汇总（214 条）
│   ├── meta.json                # 元数据（话题列表、级别、统计）
│   ├── videos.json              # 原始视频元数据
│   ├── video_ids.txt            # 视频 ID 列表
│   ├── process_data.py          # 数据处理脚本（生成 consolidated.json）
│   ├── subtitles/               # 字幕 JSON 文件（每个视频一个）
│   ├── thumbnails/              # 缩略图
│   ├── videos/                  # 本地视频文件
│   └── vidDict.db               # SQLite 数据库（用户、生词、听写记录）
│
├── server/                      # 后端 API
│   ├── index.cjs                # Express 入口（端口 3001）
│   ├── db.cjs                   # SQLite 数据库层
│   ├── auth.cjs                 # JWT 认证中间件
│   └── routes/
│       ├── auth.cjs             # 注册/登录/获取用户
│       ├── dictation.cjs        # 听写进度 CRUD
│       └── vocab.cjs            # 生词本 CRUD
│
├── src/                         # 前端 React 应用
│   ├── main.jsx                 # 入口 + 路由配置
│   ├── App.jsx                  # 布局 + 导航栏
│   ├── index.css                # 全局样式（31K）
│   ├── context/
│   │   └── AuthContext.jsx      # 认证上下文（login/register/logout/authFetch）
│   └── pages/
│       ├── Library.jsx          # 视频库（搜索/筛选/分页）
│       ├── VideoDetail.jsx      # 视频播放 + 双语字幕 + 查词
│       ├── DictationPage.jsx    # 听写模式（核心特色）
│       ├── LearningRecords.jsx  # 学习记录（观看历史/生词本）
│       └── Login.jsx            # 登录/注册页面
│
├── public/                      # 静态资源
├── dist/                        # 构建产物
├── fetch_subtitles.sh           # 批量下载字幕
├── download_videos.sh           # 批量下载视频
├── download_thumbnails.sh       # 批量下载缩略图
├── download_missing.py          # 补下缺失视频
├── vite.config.js               # Vite 配置（代理 + 数据服务插件）
├── package.json
└── eslint.config.js
```

---

## 数据来源与处理

视频数据通过以下管道准备：

1. **视频元数据** → `data/videos.json`
2. **下载字幕** → `./fetch_subtitles.sh`（从 API 批量拉取）
3. **下载缩略图** → `./download_thumbnails.sh`
4. **下载视频** → `./download_videos.sh`（可选，用于本地播放）
5. **数据汇总** → `python3 data/process_data.py`（合并为 `consolidated.json` + `meta.json`）

前端直接读取 `data/` 目录下的 JSON 文件（开发时通过 Vite 自定义插件 `/data/` 路由提供静态文件服务）。

---

## API 接口

| 方法 | 路径 | 说明 | 认证 |
|---|---|---|---|
| POST | `/api/auth/register` | 注册 | ❌ |
| POST | `/api/auth/login` | 登录 | ❌ |
| GET | `/api/auth/me` | 获取当前用户 | ✅ |
| GET | `/api/dictation/:videoId` | 获取听写进度 | ✅ |
| PUT | `/api/dictation/:videoId` | 保存听写进度 | ✅ |
| GET | `/api/vocab` | 获取生词列表 | ✅ |
| POST | `/api/vocab` | 添加生词 | ✅ |
| DELETE | `/api/vocab/:word` | 删除生词 | ✅ |
| GET | `/api/health` | 健康检查 | ❌ |

---

## 开发说明

- 前端开发：`npm run dev`（Vite 热更新）
- 后端开发：`npm run server`（nodemon 未配置，需要手动重启）
- 代码检查：`npm run lint`
- 热更新期间 `/data/` 下的 JSON 文件变更会立即反映到页面

---

## 许可

本项目仅供个人学习使用。视频内容版权归各自创作者所有。
