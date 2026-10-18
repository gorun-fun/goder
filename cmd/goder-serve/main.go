// goder-serve — 纯 web 形态服务端(多用户网关):静态托管前端构建产物 +
// 把 /goder-api/* 路由到"当前用户专属的 gh server 子进程"。
//
// 身份模式(GODER_IDENTITY):
//
//	single  单用户(默认)。所有人共用一个 gh server;配 GODER_UPSTREAM 时
//	        直接反代该外部地址(不托管进程,令牌由浏览器携带,兼容旧行为)。
//	header  信任上级网关注入的用户头(被三方集成时推荐):三方应用自己完成
//	        SSO,其后端反代到本服务并注入 GODER_UID_HEADER(默认 X-GRF-UID)。
//	sso     内置 Casdoor OAuth2 授权码登录(独立部署的完整方案),
//	        /goder-api/auth/* 提供登录/回调/登出/当前用户端点。
//
// 多用户托管:一个 uid 一个 gh server 进程(独立端口池 + 数据目录
// <GODER_DATA>/users/<uid>/server-data);各进程令牌由本服务注入,不下发浏览器。
// header/sso 模式默认每用户独立 GRF_HOME(<...>/users/<uid>/grf-home,
// settings.json/技能/插件全部按用户隔离,网页设置页 /v1/agent/* 落到用户
// 自己的配置;GODER_USER_HOME=0 关闭回到共享宿主 ~/.grf)。GODER_SETTINGS_SEED
// 指向宿主 settings.json 时,用户首启无配置则复制一份作初始快照(之后
// 完全独立;GODER_SETTINGS_SEED=1 取宿主 GRF_HOME/~/.grf 的 settings.json)。
//
// 常用环境变量:
//
//	ADDR(127.0.0.1:7700)   GODER_DATA(./goder-web-data)  GODER_BIN(gh)
//	GODER_STATIC_DIR(frontend/dist)  GODER_CORS(1)
//	GODER_PORT_MIN/MAX(17400/18400)  GODER_MAX_USERS(50)  GODER_IDLE_TTL(30m)
//	GODER_UPSTREAM(仅 single)  GODER_UID_HEADER(X-GRF-UID)  GODER_NAME_HEADER(X-GRF-Name)
//	GODER_USER_HOME(1)  GODER_SETTINGS_SEED(空/1/绝对路径)
//	SSO_ENDPOINT / SSO_CLIENT_ID / SSO_CLIENT_SECRET / SSO_REDIRECT_URL /
//	SSO_ORGANIZATION / AUTH_DEV_EMAIL / COOKIE_SECURE / GODER_SESSIONS_FILE(仅 sso)
//	GODER_CORS_ORIGINS(逗号分隔白名单,给出时精确放行+允许凭据,优先于 GODER_CORS)
//	GODER_ADMIN_TOKEN(/admin/* 管理 API 令牌;空 = 关闭)  GODER_WEBHOOK_URL(进程
//	生命周期事件回调;空 = 关闭)  GODER_WEBHOOK_SECRET(回调 HMAC-SHA256 签名密钥)
//	GODER_ACCESS_LOG(1 = 请求日志)
//	GODER_GH_ENV_<KEY>(透传额外环境给每个 gh 子进程,如
//	  GODER_GH_ENV_GRF_TURN_WEBHOOK_URL / GODER_GH_ENV_GRF_TURN_WEBHOOK_SECRET
//	  开启 gh 回合终态事件外发——宿主无头任务由轮询转事件驱动)
package main

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"git.gorun.fun/share/goder/pkg/gateway"
	"git.gorun.fun/share/goder/pkg/ghserver"
	"git.gorun.fun/share/goder/pkg/identity"
)

func main() {
	addr := env("ADDR", "127.0.0.1:7700")
	dataDir := env("GODER_DATA", "goder-web-data")
	staticDir := env("GODER_STATIC_DIR", "frontend/dist")
	ghBin := env("GODER_BIN", "gh")

	opts := gateway.Options{
		APIPrefix:  "/goder-api",
		StaticDir:  staticDir,
		CORS:       envBool("GODER_CORS", true),
		AdminToken: env("GODER_ADMIN_TOKEN", ""),
		WebhookURL: env("GODER_WEBHOOK_URL", ""),
		// 事件回调 HMAC-SHA256 签名密钥(公网/跨信任域回调必配;接收方
		// 常量时间校验 X-Goder-Signature 头)。
		WebhookSecret: env("GODER_WEBHOOK_SECRET", ""),
		AccessLog:     envBool("GODER_ACCESS_LOG", false),
	}
	if v := os.Getenv("GODER_CORS_ORIGINS"); v != "" {
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				opts.CORSOrigins = append(opts.CORSOrigins, o)
			}
		}
	}

	switch env("GODER_IDENTITY", "single") {
	case "single":
		upstream := env("GODER_UPSTREAM", "")
		if upstream != "" {
			// 直连外部 gh server(不托管进程):令牌由浏览器携带。
			u, err := url.Parse(upstream)
			if err != nil {
				log.Fatalf("GODER_UPSTREAM 非法: %v", err)
			}
			opts.FixedUpstream = u
			log.Printf("身份模式: single(直连上游 %s,不托管进程)", upstream)
		} else {
			opts.Resolver = identity.NewSingle(identity.SingleConfig{UID: "local", Name: "本地用户"})
			opts.Manager = ghserver.NewManager(ghserver.ManagerConfig{
				GhBin: ghBin, DataRoot: dataDir, MaxUsers: 1,
			})
			log.Printf("身份模式: single(自托管单进程,数据 %s)", dataDir)
		}
	case "header":
		uidHeader := env("GODER_UID_HEADER", "X-GRF-UID")
		opts.Resolver = identity.NewHeader(identity.HeaderConfig{
			UIDHeader:  uidHeader,
			NameHeader: env("GODER_NAME_HEADER", "X-GRF-Name"),
		})
		opts.Manager = managerFromEnv(ghBin, dataDir)
		log.Printf("身份模式: header(uid 头 %s;仅接受可信上级反代的流量)", uidHeader)
	case "sso":
		cfg := identity.SSOConfig{
			Endpoint:     env("SSO_ENDPOINT", ""),
			ClientID:     env("SSO_CLIENT_ID", ""),
			ClientSecret: env("SSO_CLIENT_SECRET", ""),
			RedirectURL:  env("SSO_REDIRECT_URL", ""),
			Organization: env("SSO_ORGANIZATION", ""),
			DevEmail:     env("AUTH_DEV_EMAIL", ""),
			CookieSecure: envBool("COOKIE_SECURE", false),
		}
		if cfg.DevEmail == "" && (cfg.Endpoint == "" || cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "") {
			log.Fatalf("sso 模式需要 SSO_ENDPOINT/SSO_CLIENT_ID/SSO_CLIENT_SECRET/SSO_REDIRECT_URL(或 AUTH_DEV_EMAIL 开发后门)")
		}
		if f := env("GODER_SESSIONS_FILE", ""); f != "" {
			cfg.Sessions = identity.NewFileSessions(f)
			log.Printf("会话持久化: %s(重启免重登)", f)
		}
		opts.Resolver = identity.NewSSO(cfg)
		opts.Manager = managerFromEnv(ghBin, dataDir)
		log.Printf("身份模式: sso(Casdoor %s;登录入口 /goder-api/auth/login)", cfg.Endpoint)
	default:
		log.Fatalf("未知 GODER_IDENTITY: %s(可选 single|header|sso)", env("GODER_IDENTITY", ""))
	}

	gw := gateway.New(opts)
	server := &http.Server{
		Addr:    addr,
		Handler: gw.Handler(),
		// 慢连接防护:头/体读取设限,空闲连接回收;WriteTimeout 不设
		// —— SSE 长响应会被它掐断(流式聊天的主链路)。
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		log.Printf("收到退出信号,回收用户进程…")
		gw.Shutdown()
		// 优雅退出:给在途请求(含 SSE)5s 收尾,超时强关。
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	log.Printf("goder-serve: http://%s  (API /goder-api,静态 %s)", addr, staticDir)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// managerFromEnv 从环境变量构建多用户进程管理器。
// GODER_USER_HOME(默认 1):每用户独立 GRF_HOME;GODER_SETTINGS_SEED
// (空/1/绝对路径):用户首启无 settings.json 时的播种来源;
// GODER_GH_ENV_<KEY>=<value>:透传额外环境给每个 gh 子进程(如
// GODER_GH_ENV_GRF_TURN_WEBHOOK_URL / _SECRET 开回合事件外发)。
func managerFromEnv(ghBin, dataDir string) *ghserver.Manager {
	return ghserver.NewManager(ghserver.ManagerConfig{
		GhBin:        ghBin,
		DataRoot:     dataDir,
		PortMin:      envInt("GODER_PORT_MIN", 17400),
		PortMax:      envInt("GODER_PORT_MAX", 18400),
		MaxUsers:     envInt("GODER_MAX_USERS", 50),
		IdleTTL:      envDur("GODER_IDLE_TTL", 30*time.Minute),
		ReadyTimeout: envDur("GODER_READY_TIMEOUT", 15*time.Second),
		PerUserHome:  envBool("GODER_USER_HOME", true),
		SettingsSeed: settingsSeedFromEnv(),
		ExtraEnv:     ghExtraEnvFromEnv(),
	})
}

// ghExtraEnvFromEnv 收集 GODER_GH_ENV_<KEY>=<value> 形态的环境变量,
// 剥前缀后作为 KEY=<value> 透传给每个 gh 子进程。键名内可含下划线
// (环境变量名合法字符),如 GODER_GH_ENV_GRF_TURN_WEBHOOK_URL →
// GRF_TURN_WEBHOOK_URL。
func ghExtraEnvFromEnv() []string {
	var out []string
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || !strings.HasPrefix(k, "GODER_GH_ENV_") {
			continue
		}
		key := strings.TrimPrefix(k, "GODER_GH_ENV_")
		if key == "" {
			continue
		}
		out = append(out, key+"="+v)
	}
	return out
}

// settingsSeedFromEnv 解析播种来源:"1" = 宿主默认配置,绝对路径 = 指定
// settings.json,空 = 不播种(纯隔离,用户自行配置)。
func settingsSeedFromEnv() string {
	v := os.Getenv("GODER_SETTINGS_SEED")
	if v == "" || v == "0" {
		return ""
	}
	if v != "1" {
		return v
	}
	if h := os.Getenv("GRF_HOME"); h != "" {
		return h + "/settings.json"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home + "/.grf/settings.json"
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// envBool 读布尔环境变量;设了但解析失败记警告并回落默认(不静默吞掉
// 配置错误,便于部署方发现拼错的值)。
func envBool(k string, def bool) bool {
	if v := os.Getenv(k); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
		log.Printf("环境变量 %s=%q 不是合法布尔值,回落默认 %v", k, v, def)
	}
	return def
}

// envInt 读整数环境变量;解析失败同样警告并回落默认。
func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		log.Printf("环境变量 %s=%q 不是合法整数,回落默认 %d", k, v, def)
	}
	return def
}

// envDur 读时长环境变量(如 30m / 15s);解析失败同样警告并回落默认。
func envDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		log.Printf("环境变量 %s=%q 不是合法时长,回落默认 %s", k, v, def)
	}
	return def
}
