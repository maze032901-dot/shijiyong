# 从零安装

## 1. 前提

- 云服务器：可运行 Docker Compose；有自己的域名，A/AAAA 记录指向服务器，80 和 443 端口可达。服务器负责队列和已发布内容，不负责 ASR/OCR。
- Mac：Node.js 22+、Python 3.10–3.13（建议 3.11）、ffmpeg、Google Chrome（备用网页抓取）、whisper.cpp 与 `ggml-large-v3-turbo.bin` 模型；当前 F2 依赖不支持 Python 3.14。首次安装还需要联网下载 Python 依赖和 RapidOCR 模型。
- Android：Android Studio / SDK 36、JDK 17+。首版在一加 15T / ColorOS 16 验证过采集入口；其他机型需自行测试权限与后台限制。
- 自己申请模型 API Key，模型入口需兼容 OpenAI Chat Completions；模型费用由自己承担。

把仓库克隆到你自己的设备。以下所有命令都在仓库根目录运行，且不得使用现有个人部署的密钥。

## 2. 云端

将 `deploy/.env.example` 复制为根目录 `.env`（`cp deploy/.env.example .env && chmod 600 .env`），填写自己的域名、三枚**互不相同**的随机密钥、Caddy 用户名和密码哈希。每枚密钥建议用 `openssl rand -hex 32` 分别生成；不要在命令行、聊天或截图里粘贴密钥。

密码哈希可运行 `docker run --rm -it caddy:2.8-alpine caddy hash-password` 交互生成；不要把明文密码写进 `.env`，并用单引号包住哈希，避免 Docker Compose 把其中的 `$` 当作变量。[Caddy 命令说明](https://caddyserver.com/docs/command-line#caddy-hash-password)、[Docker Compose 引号规则](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax)。在服务器安装 Node.js 22+ 后可运行：

```sh
npm run doctor -- --mode cloud
docker compose -f docker-compose.cloud.yml config --quiet
docker compose -f docker-compose.cloud.yml up -d --build
docker compose -f docker-compose.cloud.yml ps
```

运行环境本身只需要 Docker；Node.js 仅用于上面的配置检查。打开 `https://你的域名/`，网页登录后应看到空白主题页。使用 `https://你的域名/api/health` 测试时也需要网页账号密码。不要把云端地址设成开发者的个人服务。

`.env` 和 `data/` 都在仓库根目录，但已被 Git 忽略；`data/` 是持久数据，升级时不要删除。云端容器中未配置模型 API；模型密钥只保存在 Mac。

## 3. Mac 处理器

在 Mac 克隆同一个仓库，运行：

```sh
npm ci
./scripts/setup-mac.sh
```

按 whisper.cpp 自己的安装说明构建 `whisper-cli`，并取得 `ggml-large-v3-turbo.bin`。二者不随本仓库分发；把程序与模型放在默认路径 `runtime/asr/whisper.cpp/build/bin/whisper-cli` 和 `runtime/asr/whisper.cpp/models/ggml-large-v3-turbo.bin`，或设置 `HERMES_WHISPER_CPP_PATH`、`HERMES_WHISPER_CPP_MODEL` 指向你自己的绝对路径。运行 `npm run doctor -- --mode mac` 可发现缺项。

运行 `npm run configure:cloud-status`，依次输入自己的 HTTPS 云端地址、云端 `HERMES_INTAKE_TOKEN`、云端 `HERMES_MOBILE_PUBLISH_TOKEN`。它们只写入 Mac 的 `runtime/cloud-status.local.json`（权限 0600），不会回显。随后先运行 `npm start`，在 Mac 本机打开 `http://127.0.0.1:4318/providers`，配置并测试自己的模型供应商；再单独运行 `npm run watch:cloud`。两个进程都需保持运行，Mac 休眠时处理会暂停，但已发布的手机/云端快照可继续浏览。

自动抓取使用仓库内保留许可证的 F2；失败时尝试公开网页备用入口。两者都可能被平台限制。视频使用 whisper.cpp large-v3-turbo，图文与视频关键帧使用 RapidOCR。首次 OCR 运行可能下载模型，需保证网络可用。

成卡前会对卡片中明确写出的 GitHub `作者/仓库` 名称向 GitHub 公共 API 做一次有限核实；同一张卡只有一个已核实作者时，也会核实明确提到的同作者插件仓库。核实成功才提供可点击的项目地址；查询失败、限流或名称不确定时保留“未核实”线索，不猜链接，也不阻塞成卡。这一步会把待核实的仓库名称发送给 GitHub，不发送完整证据或模型密钥。若不希望进行外部查询，在启动 Mac 处理器前设置 `HERMES_GITHUB_LOOKUP=0`。

## 4. Android

按 [Android 构建说明](../android/README.md) 从源码本地构建并安装。App 里将“手机卡片库”填自己的云端 HTTPS 地址和 `HERMES_MOBILE_TOKEN`；“收藏上传”填同一地址和 `HERMES_INTAKE_TOKEN`。`HERMES_MOBILE_PUBLISH_TOKEN` **只在云端和 Mac 配置**，不填进手机。启用抖音采集所需的无障碍权限，并关闭影响后台同步的省电限制。

## 本地补交媒体

抓取失败后，收藏事件仍在云端。先自行合法保存该作品的 MP4 或图文图片，再在 Mac 运行：

```sh
npm run attach:media -- --event 你的事件ID --kind video --file /绝对路径/视频.mp4
npm run attach:media -- --event 你的事件ID --kind gallery --file /绝对路径/第1张.png --file /绝对路径/第2张.jpg
```

事件 ID 可从云端队列查看。补交命令只接受已存在且未发布的原收藏，复制到 Mac 私有 `runtime/manual-media/`，并在本机排入识别阶段；不会新建收藏或上传原媒体到云端。一个视频最多 250 MiB，图文最多 20 张、每张最多 30 MiB。`npm run watch:cloud` 要保持运行。若成卡失败，任务仍保留，可从失败阶段重试。
