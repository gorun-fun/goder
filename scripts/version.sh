#!/bin/sh
# version.sh — 输出 Goder 当前发版应使用的版本号(本地 build.sh 与 CI 共用)。
#
# 打版规则:跟随 grf-harness(gh)的最新发布 tag(如 0.0.1-alpha.12);
# gh 未更新而本程序又有调整需要发版时,在其后追加 .postN(N 从 0 递增):
#   gh 最新 = 0.0.1-alpha.12 时:
#     本程序首次基于它发版        → 0.0.1-alpha.12
#     gh 不变,本程序再次发版      → 0.0.1-alpha.12.post0
#     再发一版                    → 0.0.1-alpha.12.post1
#   gh 升到 0.0.1-alpha.13 后     → 重新从 0.0.1-alpha.13 起算
#
# 判定依据:下载服务器目录列表。
#   gh 基线:  ${GH_DL_BASE:-https://download.gorun.fun/grf-harness}/macos-arm64/
#   已发版本: ${GODER_DL_BASE:-https://download.gorun.fun/goder}/macos-arm64/
# 数同基线的已发布版本个数 N(plain + post0..postN-1):
#   N=0 → 直接用 gh 版本;N≥1 → 追加 .post$((N-1))。
set -e

GH_DL_BASE="${GH_DL_BASE:-https://download.gorun.fun/grf-harness}"
GODER_DL_BASE="${GODER_DL_BASE:-https://download.gorun.fun/goder}"

# 目录列表页为静态 HTML,版本号是 href 里的目录名,sort -V 取最大
list_versions() {
  curl -fsSL "$1/macos-arm64/" 2>/dev/null \
    | grep -oE 'href="[0-9][^"/]*/"' | cut -d'"' -f2 | tr -d /
}

GH_VERSION=$(list_versions "$GH_DL_BASE" | sort -V | tail -1)
if [ -z "$GH_VERSION" ]; then
  echo "错误: 获取 gh(grf-harness)最新版本失败" >&2
  exit 1
fi

# 本项目尚未发布过(目录 404)时列表为空,N=0
N=0
for v in $(list_versions "$GODER_DL_BASE"); do
  case "$v" in
    "$GH_VERSION" | "$GH_VERSION".post*) N=$((N + 1)) ;;
  esac
done

if [ "$N" -eq 0 ]; then
  echo "$GH_VERSION"
else
  echo "$GH_VERSION.post$((N - 1))"
fi
