#!/bin/zsh
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo "请先安装 Android SDK 36，并设置 ANDROID_HOME（或 ANDROID_SDK_ROOT）。" >&2
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
"$project_root/android/gradlew" --no-daemon --no-watch-fs -p "$project_root/android" \
  testDebugUnitTest assembleDebug

echo "APK: $project_root/android/app/build/outputs/apk/debug/app-debug.apk"
