# goder-builder — GitLab CI build job 专用编译镜像
#
# 背景:runner(docker 执行器,if-not-present 拉取策略)与本镜像同机,bake 进
# 全部重依赖,build job 跳过 apt 安装与工具链下载,直接进入编译。
#
# 内容(基于 golang:1.26-trixie,amd64 host):
#   - linux 原生构建:build-essential + GTK4/WebKitGTK 6.0 dev 头
#   - linux arm64 交叉:gcc-aarch64-linux-gnu + libc6-dev-arm64-cross
#     + 预解包 sysroot /opt/xs/arm64(GTK/WebKitGTK dev 完整依赖闭包;
#     dev 包双架构自冲突,不能 apt 安装,构建期用独立 apt 状态目录解析
#     闭包下载 dpkg -x)+ libc.so 链接脚本所需符号链接
#   - darwin 双架构交叉:zig cc 0.14 + macOS SDK 14.5 + ldid(adhoc 签名)
#     + 预生成的 zcc 包装器 /opt/mc/bin/zcc-darwin-{arm64,amd64}
#     (剥掉 go/cgo 注入的 -target/-mmacosx-version-min,指向 SDK sysroot)
#   - windows:纯 Go 交叉,无 CGO,无需工具链
#
# 构建(runner 宿主机上;首构建需下载 zig/SDK/sysroot 闭包,约几分钟):
#   docker build -t goder-builder:1.26 ci/
# 改依赖后:bump tag 重构建并推送 .gitlab-ci.yml 的 image 名。
# 镜像与 runner 同机 + if-not-present,无需 registry;换机时 docker save/load。

FROM golang:1.26-trixie

ENV DEBIAN_FRONTEND=noninteractive
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
  && dpkg --add-architecture arm64 \
  && apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
       build-essential pkg-config libgtk-4-dev libwebkitgtk-6.0-dev \
       curl xz-utils zip ca-certificates \
       gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
  && rm -rf /var/lib/apt/lists/*

# ---- darwin 交叉工具链:zig + macOS SDK + ldid,预生成 zcc 包装器 ----
RUN mkdir -p /opt/mc/bin \
  && case "$(uname -m)" in aarch64) ZA=aarch64 ;; *) ZA=x86_64 ;; esac \
  && curl -fsSL "https://ziglang.org/download/0.14.0/zig-linux-${ZA}-0.14.0.tar.xz" \
       | tar -xJ -C /opt/mc --strip-components=1 \
  && curl -fsSL "https://github.com/joseluisq/macosx-sdks/releases/download/14.5/MacOSX14.5.sdk.tar.xz" \
       | tar -xJ -C /opt/mc \
  && case "$(uname -m)" in aarch64) LA=arm64 ;; *) LA=x86_64 ;; esac \
  && curl -fsSL "https://github.com/ProcursusTeam/ldid/releases/latest/download/ldid_linux_${LA}" \
       -o /opt/mc/bin/ldid && chmod +x /opt/mc/bin/ldid \
  && for ARCH in arm64 amd64; do \
       case "$ARCH" in arm64) ZT=aarch64 ;; *) ZT=x86_64 ;; esac; \
       printf '#!/bin/sh\nARGS=""\nSKIP_NEXT=0\nfor arg in "$@"; do\n    if [ $SKIP_NEXT -eq 1 ]; then SKIP_NEXT=0; continue; fi\n    case "$arg" in\n        -target) SKIP_NEXT=1 ;;\n        -mmacosx-version-min=*) ;;\n        *) ARGS="$ARGS $arg" ;;\n    esac\ndone\nexec "%s" cc -fno-sanitize=all -target "%s-macos-none" -isysroot "%s" -I"%s/usr/include" -L"%s/usr/lib" -F"%s/System/Library/Frameworks" -w $ARGS\n' \
         /opt/mc/zig "$ZT" /opt/mc/MacOSX14.5.sdk /opt/mc/MacOSX14.5.sdk /opt/mc/MacOSX14.5.sdk /opt/mc/MacOSX14.5.sdk \
         > /opt/mc/bin/zcc-darwin-${ARCH} && chmod +x /opt/mc/bin/zcc-darwin-${ARCH}; \
     done
ENV PATH=/opt/mc/bin:$PATH

# ---- linux arm64 交叉 sysroot:GTK/WebKitGTK dev 完整依赖闭包 ----
# 独立 apt 状态目录把 arm64 当"原生"解析闭包(空 status,--print-uris 出全部
# URL),下载 .deb 解包到 /opt/xs/arm64。deb 数与 URL 数校验防半成品。
RUN mkdir -p /xsapt/lists/partial /xsapt/cache/archives/partial /xsapt/dpkg /opt/xs \
  && : > /xsapt/dpkg/status \
  && XOPTS="-o Dir::State=/xsapt -o Dir::Cache=/xsapt/cache \
       -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/debian.sources \
       -o Dir::Etc::sourceparts=/dev/null \
       -o Dir::State::status=/xsapt/dpkg/status \
       -o APT::Architecture=arm64 -o APT::Architectures=arm64" \
  && apt-get $XOPTS update -qq \
  && mkdir -p /xsapt/debs && cd /xsapt/debs \
  && apt-get $XOPTS --print-uris -y --no-install-recommends install \
       libgtk-4-dev libwebkitgtk-6.0-dev \
       | grep -oE "'https?://[^']+'" | tr -d "'" > /tmp/urls.txt \
  && xargs -r -n1 curl -fsSLO < /tmp/urls.txt \
  && GOT=$(ls *.deb | wc -l) && WANT=$(wc -l < /tmp/urls.txt) \
  && [ "$GOT" = "$WANT" ] || { echo "deb 下载不完整 $GOT/$WANT"; exit 1; } \
  && for d in *.deb; do dpkg -x "$d" /opt/xs/arm64; done \
  && cd / && rm -rf /xsapt /tmp/urls.txt \
  # libc.so 链接脚本写死目标机绝对路径,补符号链接到交叉工具链目录
  && mkdir -p /lib/aarch64-linux-gnu /usr/lib/aarch64-linux-gnu \
  && for f in /usr/aarch64-linux-gnu/lib/libc.so.6 /usr/aarch64-linux-gnu/lib/libc_nonshared.a; do \
       ln -sf "$f" /lib/aarch64-linux-gnu/ && ln -sf "$f" /usr/lib/aarch64-linux-gnu/; \
     done \
  && ln -sf /usr/aarch64-linux-gnu/lib/ld-linux-aarch64.so.1 /lib/
