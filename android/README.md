# 拾即用 Android 源码构建

首版是 Kotlin + Jetpack Compose 技术预览。保留“在抖音点击复制链接 → 无障碍服务触发剪贴板桥接 → 本地队列 → 云端上传”的采集链路，并显示云端已发布的主题、卡片、图片与解析状态。无障碍服务只针对普通抖音包名 `com.ss.android.ugc.aweme`；请在安装后自己核对权限说明。

准备 JDK 17+、Android SDK 36、网络连接，并设置 `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`）。在仓库根目录运行 `./android/build-local.sh`；它执行单元测试并产生 `android/app/build/outputs/apk/debug/app-debug.apk`，仅供你在自己的设备上验证。Debug 包使用独立的 `cn.hermes.capture.preview` 标识和“拾即用预览版”名称，可与现有个人 App 并存，设置与采集队列互不覆盖。仓库不发布临时调试签名 APK。测试采集时请先停用现有个人 App 的无障碍服务，再启用预览版的服务，以免同一次复制被两个服务同时处理。

首次打开 App 时自行填写云端地址与两种手机凭据：卡片库使用 `HERMES_MOBILE_TOKEN`，收藏上传使用 `HERMES_INTAKE_TOKEN`。Mac 发布凭据不输入手机。授予无障碍权限后，按系统提示处理后台运行/省电限制。当前采集入口只在一加 15T / ColorOS 16 实测；其他机型或 Android 版本要重新验证。Debug 构建仅用于本地开发，面向他人发布前必须另行设计签名、更新与权限说明。
