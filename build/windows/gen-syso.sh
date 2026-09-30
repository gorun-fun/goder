#!/bin/sh
# gen-syso.sh — 重新生成 Windows 资源 syso(图标 + manifest + 版本信息),
# 在仓库根执行:sh build/windows/gen-syso.sh
# 产出 rsrc_windows_{amd64,arm64}.syso,go build(GOOS=windows)自动链接;
# 改应用显示名(FileDescription,任务栏/资源管理器里的名字)、图标或
# manifest 后跑本脚本重新生成并提交。
# 应用显示名统一为 Goder(winres.json 的 FileDescription);manifest 为
# comctl32 v6 + per-monitor DPI v2 + supportedOS(app.manifest);资源内
# 版本号是占位,实际版本以 CI ldflags 注入的 appVersion 为准。
# icon-frames/ 的 7 张 PNG 由 icon.ico(7 帧 PNG 压缩 ico)拆帧而来——
# go-winres 解不了 PNG 帧 ico,改图标时直接替换对应尺寸的帧文件。
set -e
cd "$(dirname "$0")/../.."
# --no-suffix + 完整目标名:产出与仓库既有约定一致的
# rsrc_windows_{amd64,arm64}.syso(go build 自动按 GOOS/GOARCH 匹配链接)
for ARCH in amd64 arm64; do
  go run github.com/tc-hib/go-winres@latest make \
    --in build/windows/winres.json --out "rsrc_windows_${ARCH}.syso" \
    --arch "$ARCH" --no-suffix
done
ls -l rsrc_windows_amd64.syso rsrc_windows_arm64.syso
