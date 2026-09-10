#!/usr/bin/env bash
# start.sh — grf-harness-ui 桌面 App 生命周期管理。
#   ./start.sh build [args]   构建(透传给 ./build.sh;如 `build app` 组装 .app)
#   ./start.sh start          启动(缺二进制时自动构建;后台运行,PID 记录在 .run/)
#   ./start.sh stop           停止(优雅退出;并回收 app 托管的 gh server)
#   ./start.sh restart        重启
set -euo pipefail
cd "$(dirname "$0")"

RUN_DIR=".run"
PID_FILE="$RUN_DIR/app.pid"
LOG_FILE="$RUN_DIR/app.log"
APP_BUNDLE="dist/grf-harness-ui.app"
APP_BIN="grf-harness-ui"
# 托管 gh server 的数据目录特征串(stop 时定向回收,避免误杀其它 gh 实例)
GH_DATA_MARK="grf-harness-ui/server-data"

mkdir -p "$RUN_DIR"

app_command() {
  # 优先 .app 内的二进制,其次裸二进制;输出空表示没有可执行文件
  if [ -x "$APP_BUNDLE/Contents/MacOS/grf-harness-ui" ]; then
    echo "$APP_BUNDLE/Contents/MacOS/grf-harness-ui"
  elif [ -x "./$APP_BIN" ]; then
    echo "./$APP_BIN"
  fi
}

running_pid() {
  # 输出存活进程 PID;无则清掉陈旧 pid 文件并返回空
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  return 1
}

do_build() {
  echo "==> 构建(透传参数: $*)"
  ./build.sh "$@"
}

do_start() {
  if pid="$(running_pid)"; then
    echo "已在运行(pid $pid)。如需重启请用: $0 restart"
    exit 0
  fi
  local cmd
  cmd="$(app_command)"
  if [ -z "$cmd" ]; then
    echo "==> 未找到可执行文件,先构建"
    ./build.sh
    cmd="$(app_command)"
  fi
  echo "==> 启动: $cmd(日志: $LOG_FILE)"
  nohup "$cmd" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "已启动(pid $pid)"
  else
    echo "启动失败,最近日志:" >&2
    tail -5 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
}

do_stop() {
  if ! pid="$(running_pid)"; then
    echo "未在运行"
  else
    echo "==> 停止 pid $pid"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "优雅退出超时,SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "已停止"
  fi
  # 兜底:回收本 app 托管的 gh server(按数据目录特征定向匹配;
  # SIGTERM 未走 wails 退出钩子时它会残留)。
  if pgrep -f "gh server.*$GH_DATA_MARK" >/dev/null 2>&1; then
    pkill -f "gh server.*$GH_DATA_MARK" 2>/dev/null || true
    echo "已回收托管的 gh server"
  fi
}

do_restart() {
  do_stop
  sleep 0.5
  do_start
}

case "${1:-}" in
  build)  shift; do_build "$@" ;;
  start)  do_start ;;
  stop)   do_stop ;;
  restart) do_restart ;;
  *)
    cat <<USAGE
用法: $0 {build|start|stop|restart}
  build [args]   构建(透传 ./build.sh;如 "$0 build app" 组装 .app)
  start          启动 App(后台运行,PID 与日志在 .run/)
  stop           停止 App 并回收托管的 gh server
  restart        重启
USAGE
    exit 1
    ;;
esac
