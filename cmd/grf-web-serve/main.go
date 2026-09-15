// grf-web-serve — 纯 web 形态服务端(多用户网关):静态托管前端构建产物 +
// 把 /grf-api/* 路由到"当前用户专属的 gh server 子进程"。
//
// 身份模式(GRF_IDENTITY):
//
//	single  单用户(默认)。所有人共用一个 gh server;配 GRF_UPSTREAM 时
//	        直接反代该外部地址(不托管进程,令牌由浏览器携带,兼容旧行为)。
//	header  信任上级网关注入的用户头(被三方集成时推荐):三方应用自己完成
//	        SSO,其后端反代到本服务并注入 GRF_UID_HEADER(默认 X-GRF-UID)。
//	sso     内置 Casdoor OAuth2 授权码登录(独立部署的完整方案),
//	        /grf-api/auth/* 提供登录/回调/登出/当前用户端点。
//
// 多用户托管:一个 uid 一个 gh server 进程(独立端口池 + 数据目录
// <GRF_DATA>/users/<uid>/server-data);各进程令牌由本服务注入,不下发浏览器。
//
// 常用环境变量:
//
//	ADDR(127.0.0.1:7700)   GRF_DATA(./grf-web-data)  GRF_BIN(gh)
//	GRF_STATIC_DIR(frontend/dist)  GRF_CORS(1)
//	GRF_PORT_MIN/MAX(17400/18400)  GRF_MAX_USERS(50)  GRF_IDLE_TTL(30m)
//	GRF_UPSTREAM(仅 single)  GRF_UID_HEADER(X-GRF-UID)  GRF_NAME_HEADER(X-GRF-Name)
//	SSO_ENDPOINT / SSO_CLIENT_ID / SSO_CLIENT_SECRET / SSO_REDIRECT_URL /
//	SSO_ORGANIZATION / AUTH_DEV_EMAIL / COOKIE_SECURE(仅 sso)
package main

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"git.gorun.fun/share/goder/internal/gateway"
	"git.gorun.fun/share/goder/internal/ghserver"
	"git.gorun.fun/share/goder/internal/identity"
)

func main() {
	addr := env("ADDR", "127.0.0.1:7700")
	dataDir := env("GRF_DATA", "grf-web-data")
	staticDir := env("GRF_STATIC_DIR", "frontend/dist")
	ghBin := env("GRF_BIN", "gh")

	opts := gateway.Options{
		APIPrefix: "/grf-api",
		StaticDir: staticDir,
		CORS:      envBool("GRF_CORS", true),
	}

	switch env("GRF_IDENTITY", "single") {
	case "single":
		upstream := env("GRF_UPSTREAM", "")
		if upstream != "" {
			// 直连外部 gh server(不托管进程):令牌由浏览器携带。
			u, err := url.Parse(upstream)
			if err != nil {
				log.Fatalf("GRF_UPSTREAM 非法: %v", err)
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
		opts.Resolver = identity.NewHeader(identity.HeaderConfig{
			UIDHeader:  env("GRF_UID_HEADER", "X-GRF-UID"),
			NameHeader: env("GRF_NAME_HEADER", "X-GRF-Name"),
		})
		opts.Manager = managerFromEnv(ghBin, dataDir)
		log.Printf("身份模式: header(uid 头 %s;仅接受可信上级反代的流量)",
			env("GRF_UID_HEADER", "X-GRF-UID"))
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
		opts.Resolver = identity.NewSSO(cfg)
		opts.Manager = managerFromEnv(ghBin, dataDir)
		log.Printf("身份模式: sso(Casdoor %s;登录入口 /grf-api/auth/login)", cfg.Endpoint)
	default:
		log.Fatalf("未知 GRF_IDENTITY: %s(可选 single|header|sso)", env("GRF_IDENTITY", ""))
	}

	gw := gateway.New(opts)
	server := &http.Server{Addr: addr, Handler: gw.Handler()}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		log.Printf("收到退出信号,回收用户进程…")
		gw.Shutdown()
		_ = server.Close()
	}()

	log.Printf("grf-web-serve: http://%s  (API /grf-api,静态 %s)", addr, staticDir)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// managerFromEnv 从环境变量构建多用户进程管理器。
func managerFromEnv(ghBin, dataDir string) *ghserver.Manager {
	return ghserver.NewManager(ghserver.ManagerConfig{
		GhBin:        ghBin,
		DataRoot:     dataDir,
		PortMin:      envInt("GRF_PORT_MIN", 17400),
		PortMax:      envInt("GRF_PORT_MAX", 18400),
		MaxUsers:     envInt("GRF_MAX_USERS", 50),
		IdleTTL:      envDur("GRF_IDLE_TTL", 30*time.Minute),
		ReadyTimeout: envDur("GRF_READY_TIMEOUT", 15*time.Second),
	})
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	if v := os.Getenv(k); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
