// grf-web-serve — 纯 web 形态服务程序:静态托管前端构建产物 + 把
// /grf-api/* 带 CORS 头反向代理到 gh server。三方嵌入本地联调与演示用;
// 生产环境可把同样的反代放进自己的网关。
//
// 用法:
//
//	GRF_UPSTREAM=http://127.0.0.1:7400 ADDR=127.0.0.1:7700 go run ./cmd/grf-web-serve
package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

func main() {
	addr := env("ADDR", "127.0.0.1:7700")
	upstream := env("GRF_UPSTREAM", "http://127.0.0.1:7400")
	dist := env("GRF_DIST", "frontend/dist")

	target, err := url.Parse(upstream)
	if err != nil {
		log.Fatalf("GRF_UPSTREAM 非法: %v", err)
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, "/grf-api")
			if pr.Out.URL.Path == "" {
				pr.Out.URL.Path = "/"
			}
		},
		FlushInterval: -1,
	}

	mux := http.NewServeMux()
	logProxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s → %s", r.Method, r.URL.Path, upstream)
		rp.ServeHTTP(w, r)
	})
	mux.Handle("/grf-api/", withCORS(logProxy))
	mux.Handle("/grf-api", withCORS(logProxy))
	mux.Handle("/", logReq(http.FileServer(http.Dir(dist))))

	log.Printf("grf-web-serve: http://%s  (页面 / 与 /embed-demo.html,代理 → %s)", addr, upstream)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func logReq(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("static %s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

// withCORS:预检 + 简单响应都带宽松 CORS 头(本地联调工具,公网部署请收紧)。
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
