#!/bin/bash
#
# macOS 部署机更新脚本（适用于用 launchDaemon 启动的 CRS）
#
# 作用：拉取你 fork 的 main → 安装依赖 → 构建前端 dist → 重启 launchDaemon
#
# 用法：
#   ./scripts/mac-update.sh [launchDaemon-Label]
#   CRS_LABEL=com.yourname.crs ./scripts/mac-update.sh
#
# 说明：
#   - 不传 Label 时会自动探测 launchctl 中名字含 claude/relay 的服务。
#   - launchDaemon 属 system 域，重启需要 root：非 root 运行时会对 launchctl 自动加 sudo。
#   - 若仓库属 root，请整体 sudo 运行，并确保 sudo 能找到 node：
#       sudo env "PATH=$PATH" ./scripts/mac-update.sh <Label>
#
set -euo pipefail

# 用 { ... } 包裹整个脚本主体：bash 会先读完整个复合命令再执行。
# 本脚本会在运行中执行 `git reset --hard`（可能改写自身），若不整体读入内存，
# bash 按字节偏移续读被改写的文件会读到错位的半截 token，报出诸如
# “PLIST?: unbound variable” 之类的诡异错误。包裹后即可避免自我改写导致的崩溃。
{

# 1) 定位项目根目录（本脚本位于 <app>/scripts/ 下）
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
echo "📂 项目目录: $APP_DIR"

# 2) 解析 launchDaemon Label：命令行参数 > 环境变量 CRS_LABEL > 自动探测
LABEL="${1:-${CRS_LABEL:-}}"
if [ -z "$LABEL" ]; then
  LABEL="$(launchctl list 2>/dev/null | grep -iE 'claude|relay' | grep -v 'com.apple' | awk '{print $3}' | head -1 || true)"
fi
if [ -z "$LABEL" ]; then
  echo "❌ 未找到 launchDaemon Label。请显式指定："
  echo "   ./scripts/mac-update.sh <Label>"
  echo "   查找命令： sudo launchctl list | grep -iE 'claude|relay'"
  exit 1
fi
echo "🏷  launchDaemon: $LABEL"

# 非 root 时给 launchctl 加 sudo
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

# 3) 拉取 fork 的 main（强制对齐远程；.env/config/config.js/data 为 gitignore，不受影响）
echo "⬇️  拉取最新代码 (origin/main)..."
git fetch origin
git reset --hard origin/main

# 4) 安装依赖 + 构建前端（dist 不在仓库，必须本地构建）
echo "📦 安装依赖..."
npm install
echo "🔨 构建前端 dist..."
npm run build:web

# 5) 重启 launchDaemon
echo "🔄 重启服务 ($LABEL)..."
if $SUDO launchctl kickstart -k "system/$LABEL" 2>/dev/null; then
  echo "✅ 已通过 kickstart 重启"
else
  # 老系统回退到 unload/load
  PLIST="/Library/LaunchDaemons/${LABEL}.plist"
  if [ -f "$PLIST" ]; then
    $SUDO launchctl unload "$PLIST"
    $SUDO launchctl load "$PLIST"
    echo "✅ 已通过 unload/load 重启"
  else
    echo "⚠️ kickstart 失败，且未找到 $PLIST，请手动重启服务。"
    exit 1
  fi
fi

# 6) 简单状态确认
sleep 2
echo "📋 当前版本: $(cat VERSION 2>/dev/null || echo unknown)"
$SUDO launchctl list 2>/dev/null | grep -iE "$LABEL" || echo "（未在 launchctl list 看到 $LABEL，请检查服务日志）"
echo "✅ 更新完成"

exit 0
}
