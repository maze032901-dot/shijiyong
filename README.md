# 拾即用 · 自部署技术预览

拾即用把手机上复制的抖音链接变成可浏览、可复制内容的卡片。链路是：Android 采集链接 → 自己的云服务器排队 → 自己的 Mac 抓取、ASR/OCR 和成卡 → 云端同步已发布卡片及必要图片 → 手机或受密码保护的网页阅读。

这不是免配置服务。你需要自己的服务器、域名、Mac、Android 手机、模型 API 和相应费用；本仓库不会连接任何开发者的个人服务器。抓取可能被平台限制，不能保证每个链接成功。首版仅在一台 Android 设备上验证过采集入口，其他机型待验证。

## 从哪里开始

1. 按 [安装说明](docs/install.md) 配好云端、Mac 和 Android。
2. 用 `npm run doctor -- --mode cloud` / `npm run doctor -- --mode mac` 检查配置。
3. 首次用虚构数据验证隔离与权限，再用你自己的链接做端到端测试，参见 [验收清单](docs/verification.md)。

云端保留任务队列、处理状态、已发布卡片和必要图片；不接收原视频或完整审核证据。Mac 的 `runtime/` 包含本地媒体、证据、模型设置和处理日志，绝不能提交到 Git。抓取失败会保留任务、最多自动尝试三次，后续也可以在网页重试，或用 [本地补交媒体](docs/install.md#本地补交媒体)接续识别。
如果卡片已在 Mac 发布而云端暂时不可用，Mac 会在连接恢复后从本地正式发布包补同步，不重新运行识别或成卡。

## 文档

- [安装与配置](docs/install.md)
- [升级、备份和恢复](docs/operations.md)
- [故障诊断与卸载](docs/troubleshooting.md)
- [验收清单](docs/verification.md)
- [Android 源码与构建](android/README.md)
- [第三方授权](NOTICE)

## 安全与边界

接收、手机读取和 Mac 发布分别使用不同凭据；网页由 Caddy 密码保护。不要把 `.env`、`runtime/`、`data/`、视频、截图、审核结果或模型文件推送到 GitHub。Android 首版只提供源码和构建说明，不提供临时调试签名制作的公开 APK。单用户云端不能直接用作多人托管服务；增加真实用户前必须重做账号隔离、配额、密钥管理和运维。

自有代码采用 [Apache-2.0](LICENSE)。仓库内的 F2 与 Noto Serif SC 保留各自许可，详见 [NOTICE](NOTICE)。

## 旧版兼容标识

本预览版从已有项目演进而来。为保持配置、云端接口和本机数据兼容，环境变量仍使用 `HERMES_*` 前缀，Android 包名仍为 `cn.hermes.capture`（本地 Debug 构建为 `cn.hermes.capture.preview`），部分内部协议标识和 Docker 服务名也暂不改动。这些是技术标识，不是需要另行安装的服务；安装时以本仓库文档和示例配置为准。不要仅为改名而改动它们，否则旧数据与采集链路可能失效。
