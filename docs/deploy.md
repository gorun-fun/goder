# 部署指南

**中文(默认)** · [English](deploy.en.md)

goder 的纯 web 形态由 `cmd/goder-serve` 提供:静态托管前端 + `/goder-api`
多用户网关。默认 http://127.0.0.1:7700,**单用户自管模式**零配置即用——
首次 API 请求懒拉起一个 gh server(数据目录 `./goder-web-data/users/local/`)。

```sh
./build.sh web        # 构建前端 + 启动(开发联调常用)
# 或直接运行已构建的二进制
go run ./cmd/goder-serve
```

前置:`gh` 可执行文件在 PATH(或经 `GODER_BIN` 指定绝对路径),模型配置
沿用 `~/.grf/settings.json`(可用 `GRF_HOME` 重定位)。

## 身份模式

三种模式覆盖从本机联调到多用户生产:

```sh
# ① 单用户 + 直连外部 gh server(不托管进程,浏览器带 token;兼容旧行为)
GODER_IDENTITY=single GODER_UPSTREAM=http://127.0.0.1:7400 ./goder-serve

# ② 信任上级网关的用户头(被三方应用集成时推荐;一用户一 gh 进程)
#    必须部署在已完成鉴权的可信反代之后——见 docs/security.md
GODER_IDENTITY=header GODER_UID_HEADER=X-GRF-UID ADDR=:7700 ./goder-serve

# ③ 内置 Casdoor SSO(独立部署的完整方案;/goder-api/auth/* 提供登录流程)
GODER_IDENTITY=sso SSO_ENDPOINT=https://sso.example.com \
  SSO_CLIENT_ID=… SSO_CLIENT_SECRET=… \
  SSO_REDIRECT_URL=https://app.example.com/goder-api/auth/callback \
  ./goder-serve
```

header/sso 模式默认每用户独立 `GRF_HOME`(settings/技能/插件按用户隔离,
`GODER_USER_HOME=0` 关闭);`GODER_SETTINGS_SEED` 可指定宿主 settings.json
作为用户首启的初始快照(之后完全独立)。

## 环境变量全表

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADDR` | `127.0.0.1:7700` | 监听地址 |
| `GODER_DATA` | `./goder-web-data` | 数据根(`users/<uid>/` 布局) |
| `GODER_STATIC_DIR` | `frontend/dist` | 前端静态目录 |
| `GODER_BIN` | `gh` | gh 可执行文件(名字或绝对路径) |
| `GODER_IDENTITY` | `single` | `single` / `header` / `sso` |
| `GODER_UPSTREAM` | 空 | single 模式直连的外部 gh server 地址 |
| `GODER_UID_HEADER` / `GODER_NAME_HEADER` | `X-GRF-UID` / `X-GRF-Name` | header 模式的用户头 |
| `SSO_ENDPOINT` / `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` / `SSO_REDIRECT_URL` / `SSO_ORGANIZATION` | 空 | Casdoor 对接参数(sso 模式必填) |
| `AUTH_DEV_EMAIL` | 空 | sso 开发后门(免登录直发会话),**生产必须留空** |
| `COOKIE_SECURE` | `0` | sso 会话 cookie 强制 Secure(TLS 卸载部署设 1) |
| `GODER_SESSIONS_FILE` | 空(内存) | sso 会话文件持久化(0600;单实例定位,分布式需自换 SessionStore) |
| `GODER_PORT_MIN` / `GODER_PORT_MAX` | `17400` / `18400` | 用户进程端口池 |
| `GODER_MAX_USERS` | `50` | 同时托管的用户进程上限 |
| `GODER_IDLE_TTL` | `30m` | 用户进程空闲回收阈值 |
| `GODER_READY_TIMEOUT` | `15s` | gh 进程就绪等待上限 |
| `GODER_USER_HOME` | `1` | 每用户独立 GRF_HOME |
| `GODER_SETTINGS_SEED` | 空 | 用户首启播种的宿主 settings.json(`1` = 宿主默认) |
| `GODER_CORS` | `1` | API 跨域通配放行(本地联调用;公网改用白名单) |
| `GODER_CORS_ORIGINS` | 空 | 精确白名单(逗号分隔;给出时优先于 GODER_CORS,允许凭据) |
| `GODER_ADMIN_TOKEN` | 空(关闭) | `/admin/*` 管理 API 令牌;**等同代码执行权限**,内网传递 + 长随机值 |
| `GODER_WEBHOOK_URL` / `GODER_WEBHOOK_SECRET` | 空(关闭) | 进程生命周期事件回调 / HMAC-SHA256 签名密钥(跨信任域必配) |
| `GODER_ACCESS_LOG` | `0` | 请求日志(stdout:方法 路径 状态 耗时) |
| `GODER_GH_ENV_<KEY>` | — | 透传额外环境给每个 gh 子进程(如 `GODER_GH_ENV_GRF_TURN_WEBHOOK_URL` 开回合事件外发) |

管理 API(`/admin/*`,AdminToken 鉴权):进程运维 `statuses` / `start` /
`stop` / `restart`,宿主管理面(供应商声明 / 模型解析 / 插件安装 / 会话
索引 / 用户目录生命周期)——声明式集成见 [embedding.md](embedding.md)
「宿主管理面」。

## 生产部署清单

- [ ] **置于可信反代之后**并上 HTTPS(默认只监听 127.0.0.1,这是刻意
      的保守默认;对外暴露是运维的显式选择)
- [ ] **收紧 CORS**:`GODER_CORS=0` + `GODER_CORS_ORIGINS=https://你的域名`
- [ ] `header` 模式确认上级反代已完成鉴权并剥掉外来的伪造用户头
- [ ] `sso` 模式:TLS 卸载部署设 `COOKIE_SECURE=1`;确认 `AUTH_DEV_EMAIL` 为空
- [ ] 需要管理面时配 `GODER_ADMIN_TOKEN`(长随机值,仅内网)
- [ ] 配 `GODER_WEBHOOK_SECRET`(若启用事件回调)
- [ ] 定期备份 `GODER_DATA`(用户会话数据与配置)+ 宿主 `~/.grf/settings.json`
- [ ] 多实例部署:sso 会话默认单实例定位,跨实例需自换 `SessionStore`
      (Redis 等,`identity.SessionStore` 接口)

安全模型全貌见 [security.md](security.md)。
