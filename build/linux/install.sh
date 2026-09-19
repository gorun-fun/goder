#!/bin/sh
# install.sh — goder Linux 桌面集成(用户级安装,无需 root)。
# 为什么需要它:GNOME 文件管理器(Ubuntu 22.04+)双击裸可执行文件不再
# 执行,而是按内容类型找「打开方式」,application/x-executable 没有默认
# 应用,于是弹「无法打开文件」。安装 .desktop 启动器后,从应用概览/桌面
# 启动才是 Linux 上的正规入口;终端里直接运行 goder 照旧可用。
# 安装内容:可执行文件 → ~/.local/bin/goder;.desktop →
# ~/.local/share/applications/;图标 → hicolor/scalable。
set -eu
cd "$(dirname "$0")"

BIN_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
# install 落盘即赋权:解压环节丢了执行位也能装好
install -m 0755 goder "$BIN_DIR/goder"
install -m 0644 icon.svg "$ICON_DIR/goder.svg"
sed "s|@BIN@|$BIN_DIR/goder|" goder.desktop >"$APP_DIR/goder.desktop"

# 缓存刷新均为尽力而为:工具缺失或失败不影响安装结果(GTK3/GTK4 命令各试一次)
update-desktop-database "$APP_DIR" 2>/dev/null || true
gtk-update-icon-cache -q -f -t "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true
gtk4-update-icon-cache -q -f -t "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true

echo "已安装:$BIN_DIR/goder"
echo "从应用概览搜索「Goder」即可启动;图标未立即出现时注销重登一次。"
echo "(终端运行 goder 或 ./goder 照旧可用;~/.local/bin 加入 PATH 需重新登录)"
