#!/usr/bin/env bash
# build.sh — goder 构建脚本。
#   ./build.sh            构建前端 + wails 桌面二进制(./goder)
#   ./build.sh app        组装 goder.app(macOS .app 包)
#   ./build.sh embed      仅构建三方嵌入库(frontend/dist-embed/goder.js)
#   ./build.sh web        构建 + 启动纯 web 形态(goder-serve,联调用)
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 前端构建(app + embed 库)"
(cd frontend && npm install --no-audit --no-fund >/dev/null 2>&1 || npm install >/dev/null)
(cd frontend && npm run build && npm run build:embed)
# 测试装具页随嵌入产物分发(纯静态,只依赖同目录 goder.js)。
# 拷贝须在任何形态构建之后无条件执行:全量构建同样会重建(清空)
# dist-embed,只在 embed 分支拷会让全量构建悄悄丢掉该产物。
cp frontend/test-harness.html frontend/dist-embed/test-harness.html

case "${1:-}" in
  embed)
    echo "==> 嵌入库产物: frontend/dist-embed/goder.js + test-harness.html"
    exit 0
    ;;
  web)
    echo "==> 启动纯 web 形态(静态 + /goder-api 代理)"
    GODER_UPSTREAM="${GODER_UPSTREAM:-http://127.0.0.1:7400}" \
    ADDR="${ADDR:-127.0.0.1:7700}" \
    go run ./cmd/goder-serve
    exit 0
    ;;
esac

echo "==> Go 构建(wails v3 桌面)"
# macOS:Go 链接器固定按 11.0 生成 LC_BUILD_VERSION,而新版 Xcode SDK 默认把
# C/ObjC 目标文件编成当前系统版本(26+),链接时便刷一屏
# "was built for newer 'macOS' version (26.0) than being linked (11.0)"。
# 把 CGO 的部署目标显式压到同一版本即可消除(与 Info.plist 的
# LSMinimumSystemVersion 保持一致;可用 MACOS_MIN_VERSION 覆写)。
if [ "$(uname)" = "Darwin" ]; then
  MACOS_MIN_VERSION="${MACOS_MIN_VERSION:-11.0}"
  export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN_VERSION"
  export CGO_CFLAGS="-O2 -g -mmacosx-version-min=$MACOS_MIN_VERSION"
  export CGO_LDFLAGS="-O2 -g -mmacosx-version-min=$MACOS_MIN_VERSION"
fi
# 版本号注入(自更新检查用):`build.sh app` 时按发版规则推算(与
# Info.plist 同源),普通本地构建为 dev(自更新检查跳过)。
VERSION="dev"
if [ "${1:-}" = "app" ]; then
  VERSION="$(sh scripts/version.sh 2>/dev/null)" || VERSION="0.1.0"
fi
echo "==> 版本: $VERSION"
go build -ldflags "-X github.com/gorun-fun/goder/internal/desktop.appVersion=${VERSION}" -o goder .
echo "==> 二进制: ./goder"

if [ "${1:-}" = "app" ]; then
  APP="dist/goder.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

  # 程序图标:frontend/public/icon.svg → 各尺寸 PNG → iconutil 打包 icns。
  # 注意:CI(Linux runner)用仓库内提交的 build/darwin/AppIcon.icns,本地
  # 改动 icon.svg 后需按本段规则重新生成一份提交,两处保持同步。
  # 渲染器选择:ImageMagick 内置 SVG 渲染器会丢掉带 A 弧线命令的描边路径
  # (圆环消失只剩横条),不能用;qlmanage(QuickLook)系统自带且渲染正确,
  # rsvg-convert 作备选;都缺失时跳过,App 用系统默认图标。
  ICONSET="dist/AppIcon.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  if qlmanage -t -s 1024 -o "$ICONSET" frontend/public/icon.svg >/dev/null 2>&1 \
     && [ -f "$ICONSET/icon.svg.png" ]; then
    mv "$ICONSET/icon.svg.png" "$ICONSET/master.png"
  elif command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w 1024 -h 1024 frontend/public/icon.svg > "$ICONSET/master.png"
  else
    rm -rf "$ICONSET"
    echo "==> 警告: qlmanage/rsvg-convert 均不可用,跳过图标生成"
  fi
  if [ -f "$ICONSET/master.png" ]; then
    # 其余尺寸由 1024 母版缩放(sips 系统自带);512@2x 即 1024,直接用母版
    for size in 16 32 128 256 512; do
      sips -z $size $size "$ICONSET/master.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
      sips -z $((size*2)) $((size*2)) "$ICONSET/master.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
    done
    mv "$ICONSET/master.png" "$ICONSET/icon_512x512@2x.png"
    iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$ICONSET"
    rm -rf "$ICONSET"
    echo "==> 图标: AppIcon.icns"
  fi

  cp goder "$APP/Contents/MacOS/goder"

  # 捆绑 gh(独立分发:用户无需预装即可使用)。优先取构建机 PATH 里的 gh,
  # 其次 ~/bin/gh;可用 GH_BIN=... 指定。构建机没有时警告跳过,此时
  # App 仍可分发,但用户需自行安装 gh(或由内置解析找常见目录)。
  GH_BIN="${GH_BIN:-$(command -v gh 2>/dev/null || true)}"
  if [ -z "$GH_BIN" ] && [ -x "$HOME/bin/gh" ]; then GH_BIN="$HOME/bin/gh"; fi
  if [ -n "$GH_BIN" ]; then
    cp "$GH_BIN" "$APP/Contents/MacOS/gh"
    echo "==> 已捆绑 gh: $GH_BIN"
  else
    echo "==> 警告: 构建机未找到 gh,App 内未捆绑(分发前请安装 gh 或用 GH_BIN 指定)"
  fi
  # 版本号已在上方按 scripts/version.sh 推算注入二进制;此处同步写入
  # Info.plist(规则与自动推算见 scripts/version.sh,CI 同源)
  echo "==> 版本: $VERSION"
  sed -e "s/0\.1\.0/${VERSION}/g" build/darwin/Info.plist > "$APP/Contents/Info.plist"
  # 签名:优先 GODER_SIGN_IDENTITY(或本机 login 钥匙串里的 "Goder Dev" 自签
  # 证书),最后回退 adhoc。adhoc 的 TCC 授权按 cdhash 记账,每次重编都会
  # 重新弹「屏幕录制/辅助功能」权限;固定证书签名则跨构建保持授权稳定。
  SIGN_ID="${GODER_SIGN_IDENTITY:-}"
  if [ -z "$SIGN_ID" ] && security find-identity -v -p codesigning 2>/dev/null \
      | grep -q '"Goder Dev"'; then
    SIGN_ID="Goder Dev"
  fi
  if [ -n "$SIGN_ID" ]; then
    codesign --force --deep --options runtime --sign "$SIGN_ID" "$APP" >/dev/null 2>&1 \
      || codesign --force --deep --sign "$SIGN_ID" "$APP" >/dev/null 2>&1 \
      || { echo "==> 警告: 证书签名失败,回退 adhoc"; codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true; }
    echo "==> App 包: $APP(已签: $SIGN_ID)"
  else
    codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
    echo "==> App 包: $APP(未签 adhoc;分发请自行正式签名/公证)"
  fi
fi
