// shim.go — goder console-shim 子命令:gh 的 stdio MCP 插件适配器。
// 行分隔 JSON-RPC on stdin/stdout(与 gh mcp.DialStdio 的帧约定一致)
// 逐行转发到桌面进程的 /mcp 端点,应答原样写回。gh spawn 本进程的
// wrapper(~/.grf/plugins/goder-console)即 `goder console-shim <url>
// <token>`,端点与令牌由桌面安装期烙进 wrapper 内容。
//
// 主进程早期分派(main.go 在创建 wails app 之前判断 os.Args),shim
// 路径不初始化任何 GUI。桌面进程可能晚于 gh 的首次握手启动(冷启动竞
// 态):initialize 请求在连接被拒时重试数秒,其余请求直接透传错误。
package console

import (
	"bufio"
	"bytes"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// RunShim 执行 stdio→HTTP 转发,返回进程退出码。args 为 os.Args 去掉
// 程序名后的剩余参数:console-shim <endpoint> <token>。
func RunShim(args []string) int {
	if len(args) < 3 || args[0] != "console-shim" {
		fmt.Fprintln(os.Stderr, "用法: goder console-shim <mcp-endpoint> <token>")
		return 2
	}
	endpoint, token := args[1], args[2]
	client := &http.Client{Timeout: 120 * time.Second}

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 8<<20)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		resp, err := postRPC(client, endpoint, token, line)
		// 冷启动竞态:桌面监听可能尚未就绪,initialize 重试(gh 握手
		// 整体时限 15s,这里最多耗 10s)。
		for err != nil && isInitialize(line) && retryable(err) {
			time.Sleep(1 * time.Second)
			resp, err = postRPC(client, endpoint, token, line)
		}
		if err != nil {
			// 以 JSON-RPC 错误应答,gh 能把失败记进插件警告而不是挂死
			_, _ = fmt.Fprintf(out, `{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"goder-console 桌面端不可达: %s"}}%s`,
				rpcIDOf(line), jsonEscape(err.Error()), "\n")
			_ = out.Flush()
			continue
		}
		body := strings.TrimSpace(resp)
		if body != "" {
			_, _ = out.WriteString(body)
			_ = out.WriteByte('\n')
			_ = out.Flush()
		}
	}
	return 0
}

func postRPC(client *http.Client, endpoint, token, line string) (string, error) {
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader([]byte(line)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	// 应答是单条 application/json(本服务端不发 SSE)
	var buf strings.Builder
	if _, err := fmt.Fprint(&buf, readAllLimited(resp)); err != nil {
		return "", err
	}
	return strings.TrimSpace(buf.String()), nil
}

func readAllLimited(resp *http.Response) string {
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	total := 0
	for {
		n, err := resp.Body.Read(tmp)
		if n > 0 {
			total += n
			if total > 8<<20 {
				break
			}
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			break
		}
	}
	return string(buf)
}

// isInitialize 判断一行请求是否 initialize 握手(重试判定用)。
func isInitialize(line string) bool {
	return strings.Contains(line, `"initialize"`)
}

// retryable 连接类错误(桌面进程未起/端口未开)才值得重试。
func retryable(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "connect: connection") ||
		strings.Contains(msg, "EOF") ||
		strings.Contains(msg, "broken pipe")
}

// rpcIDOf 从请求行里抠出 id(缺省 0;错误应答只需可解析)。
func rpcIDOf(line string) string {
	if i := strings.Index(line, `"id":`); i >= 0 {
		rest := line[i+5:]
		if j := strings.IndexAny(rest, ",}"); j > 0 {
			return rest[:j]
		}
	}
	return "0"
}

// jsonEscape 最小 JSON 字符串转义(错误消息进 JSON 用)。
func jsonEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
