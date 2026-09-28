# 故障诊断与卸载

先运行 `npm run doctor -- --mode mac` 或 `--mode cloud`。检查服务日志时不要复制密钥、完整媒体 URL、Cookie 或个人收藏内容到公开 Issue。

| 现象 | 检查 |
| --- | --- |
| 云端 401 | 三种凭据是否填错或复用了；网页则检查 Caddy 用户名和密码。手机卡库用 mobile token，收藏上传用 intake token。 |
| 云端 404 | 域名是否指向本部署、网关是否加载当前 Caddyfile、Compose 后端是否是当前版本。 |
| 云端 502 | 网关或 Node 容器是否重启中；用 `docker compose -f docker-compose.cloud.yml ps` 与 `logs` 排查。 |
| 作品抓取失败 | 平台可能拒绝 F2 或备用入口；自动最多尝试三次，任务保留，可手动重试或本地补交媒体。 |
| 卡片不生成 | 检查 Mac doctor、`/providers` 的模型测试、输出额度、ASR/OCR 依赖和 Mac 是否睡眠。 |
| 图片缺失 | 确认 Mac 发布证据中的图片仍在 `runtime/`，手机同步是否拿到发布凭据；云端网页登录后再看网页图片。 |
| 手机不采集 | 确认无障碍权限、抖音普通包名、剪贴板读取权限与系统省电策略；其他机型尚未验证。 |

## 卸载

先停止 Mac 处理器和本地网页，再执行 `docker compose -f docker-compose.cloud.yml down`。默认不会删除 `data/` 或 Docker 命名卷。确认已有加密备份且确实不再需要数据后，再分别手动删除云端 `data/`、Compose 卷和 Mac `runtime/`；这些动作不可自动恢复。卸载 Android App 会丢失其本地缓存及未上传采集记录，应先确认云端已收到。不要在排障时直接清空任何数据目录。
