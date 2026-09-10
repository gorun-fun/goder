#!/usr/bin/env bash
# build.sh — grf-harness-ui 构建脚本。
#   ./build.sh            构建前端 + wails 桌面二进制(./grf-harness-ui)
#   ./build.sh app        组装 grf-harness-ui.app(macOS .app 包)
#   ./build.sh embed      仅构建三方嵌入库(frontend/dist-embed/grf-ui.js)
#   ./build.sh web        构建 + 启动纯 web 形态(grf-web-serve,联调用)
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 前端构建(app + embed 库)"
(cd frontend && npm install --no-audit --no-fund >/dev/null 2>&1 || npm install >/dev/null)
(cd frontend && npm run build && npm run build:embed)

case "${1:-}" in
  embed)
    echo "==> 嵌入库产物: frontend/dist-embed/grf-ui.js"
    exit 0
    ;;
  web)
    echo "==> 启动纯 web 形态(静态 + /grf-api 代理)"
    GRF_UPSTREAM="${GRF_UPSTREAM:-http://127.0.0.1:7400}" \
    ADDR="${ADDR:-127.0.0.1:7700}" \
    go run ./cmd/grf-web-serve
    exit 0
    ;;
esac

echo "==> Go 构建(wails v3 桌面)"
go build -o grf-harness-ui .
echo "==> 二进制: ./grf-harness-ui"

if [ "${1:-}" = "app" ]; then
  APP="dist/grf-harness-ui.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp grf-harness-ui "$APP/Contents/MacOS/grf-harness-ui"
  cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>grf harness</string>
  <key>CFBundleDisplayName</key><string>grf harness</string>
  <key>CFBundleIdentifier</key><string>fun.gorun.grf-harness-ui</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>grf-harness-ui</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
  echo "==> App 包: $APP(未签 adhoc;分发请自行正式签名/公证)"
fi
