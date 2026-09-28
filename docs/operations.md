# 升级、备份与恢复

## 升级

先备份，再停止 Mac 处理器。云端仓库更新代码后运行 `docker compose -f docker-compose.cloud.yml up -d --build`；不要覆盖 `.env` 和 `data/`。Mac 更新同版本代码后运行 `npm ci`、`npm run doctor -- --mode mac`，再启动本地网页和处理器。Android 重新本地构建；更换签名可能无法直接覆盖旧 App，升级前先确认配置与本地采集记录的备份。不要用本仓库覆盖已有私人部署目录。

## 备份

云端备份根目录 `.env` 与 `data/`，以及 Docker 命名卷 `caddy_data`（证书）和 `caddy_config`；备份前尽量停止写入或使用一致性快照。`data/` 含任务队列、手机快照与必要图片，备份必须加密并限制访问。

Mac 备份 `runtime/`：其中有原始证据、媒体、已发布包、重试队列、本地供应商 API Key 和云端凭据。模型可另行备份或重下载。不要把这些目录当作“示例数据”上传到 GitHub。

## 恢复

在全新部署目录恢复同版本代码、`.env`、`data/` 和需要的 Caddy 卷，再启动 Compose；运行云端 doctor 与健康检查。Mac 恢复 `runtime/` 后运行 doctor，再启动网页与处理器。恢复后检查三种凭据仍一致、队列任务没有被重复处理；不要把旧数据与另一个用户的部署混合。
