#!/bin/sh
# version.sh — 输出 Goder 当前发版应使用的版本号(本地 build.sh 与 CI 共用)。
#
# 用法:
#   sh scripts/version.sh        → Goder 下一个发版版本号(默认)
#   sh scripts/version.sh gh     → gh(grf-harness)最新发布版本号
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
#
# 版本排序:ver_max(内嵌 awk)与桌面端自动更新的 Go 侧 compareVersion
# 同一套语义(semver 式预发布 + postN 自然序),关键点:
#   0.0.1-alpha.14 < 0.0.1-beta.1 < 0.0.1-rc.1 < 0.0.1(正式版)
#   0.0.1-alpha.14 < 0.0.1-alpha.14.post9 < ...post11
# 不用 sort -V:它把正式版排在预发布之下(0.0.1 < 0.0.1-alpha.14),
# 且 postN 按字符串比(post11 < post9)。
set -e

GH_DL_BASE="${GH_DL_BASE:-https://download.gorun.fun/grf-harness}"
GODER_DL_BASE="${GODER_DL_BASE:-https://download.gorun.fun/goder}"

# 目录列表页为静态 HTML,版本号是 href 里的目录名
list_versions() {
  curl -fsSL "$1/macos-arm64/" 2>/dev/null \
    | grep -oE 'href="[0-9][^"/]*/"' | cut -d'"' -f2 | tr -d /
}

# ver_max:stdin 逐行读版本号,输出最大者(比较语义见文件头注释)。
# 用可移植 awk(mawk/BSD awk 均可,不用 gawk 扩展)。
ver_max() {
  awk '
    function isdig(s) { return s ~ /^[0-9]+$/ }
    # 数字串按数值比:去前导零,先位数再字典序
    function numcmp(a, b,  an, bn) {
      an = a; sub(/^0+/, "", an); bn = b; sub(/^0+/, "", bn)
      if (length(an) != length(bn)) return length(an) < length(bn) ? -1 : 1
      return an < bn ? -1 : (an > bn ? 1 : 0)
    }
    # tok:取 s 从 pos 起的一个"数字/非数字"连续词;结束位置经 TOKEND 传回
    function tok(s, pos,  c, cls, out) {
      if (pos > length(s)) { TOKEND = pos; return "" }
      c = substr(s, pos, 1)
      cls = (c ~ /[0-9]/) ? "[0-9]" : "[^0-9]"
      out = ""
      while (pos <= length(s) && substr(s, pos, 1) ~ cls) {
        out = out substr(s, pos, 1)
        pos++
      }
      TOKEND = pos
      return out
    }
    # 自然序:逐词比,数字词数值比、数字词排非数字词前
    function natcmp(u, v,  pu, pv, tu, tv, du, dv) {
      pu = 1; pv = 1
      while (pu <= length(u) || pv <= length(v)) {
        tu = tok(u, pu); pu = TOKEND
        tv = tok(v, pv); pv = TOKEND
        if (tu == tv) continue
        du = tu ~ /^[0-9]/
        dv = tv ~ /^[0-9]/
        if (du && dv) return numcmp(tu, tv)
        else if (du) return -1
        else if (dv) return 1
        else return tu < tv ? -1 : 1
      }
      return 0
    }
    # 段比较:数字前缀[-连字符后缀];相同时无后缀(正式)> 有后缀(预发布)
    function segcmp(x, y,  xn, xs, yn, ys, i, c) {
      if (x == y) return 0
      if (isdig(x)) { xn = x; xs = "" } else {
        i = index(x, "-")
        if (i > 1 && isdig(substr(x, 1, i - 1))) { xn = substr(x, 1, i - 1); xs = substr(x, i + 1) }
        else { xn = ""; xs = x }
      }
      if (isdig(y)) { yn = y; ys = "" } else {
        i = index(y, "-")
        if (i > 1 && isdig(substr(y, 1, i - 1))) { yn = substr(y, 1, i - 1); ys = substr(y, i + 1) }
        else { yn = ""; ys = y }
      }
      if (xn != "" && yn != "") {
        c = numcmp(xn, yn)
        if (c != 0) return c
        if (xs == "" && ys == "") return 0
        if (xs == "") return 1
        if (ys == "") return -1
        return natcmp(xs, ys)
      }
      return natcmp(x, y)
    }
    function vercmp(a, b,  na, nb, i, c) {
      sub(/^v/, "", a); sub(/^v/, "", b)
      na = split(a, A, "."); nb = split(b, B, ".")
      for (i = 1; i <= na || i <= nb; i++) {
        c = segcmp((i <= na) ? A[i] : "0", (i <= nb) ? B[i] : "0")
        if (c != 0) return c
      }
      return 0
    }
    { if (best == "" || vercmp($0, best) > 0) best = $0 }
    END { print best }
  '
}

GH_VERSION=$(list_versions "$GH_DL_BASE" | ver_max)
if [ -z "$GH_VERSION" ]; then
  echo "错误: 获取 gh(grf-harness)最新版本失败" >&2
  exit 1
fi

# 子命令:仅输出 gh 最新版本(CI 捆绑 gh 下载用,与发版推算同一套排序)
if [ "${1:-}" = "gh" ]; then
  echo "$GH_VERSION"
  exit 0
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
