// color.go — 前端上报的 CSS 颜色解析(各平台原生视图共用)。
package browser

import (
	"fmt"
	"strings"
)

// parseCSSColor 解析前端可能上报的 CSS 颜色格式(#rgb / #rrggbb /
// rgb() / rgba()),返回 0..1 的分量与不透明度;解析失败 ok=false。
func parseCSSColor(css string) (r, g, b, a float64, ok bool) {
	css = strings.TrimSpace(strings.ToLower(css))
	switch {
	case strings.HasPrefix(css, "#"):
		h := css[1:]
		if len(h) == 3 {
			var rr, gg, bb byte
			if _, err := fmt.Sscanf(h, "%1x%1x%1x", &rr, &gg, &bb); err != nil {
				return 0, 0, 0, 0, false
			}
			r, g, b = float64(rr*17)/255, float64(gg*17)/255, float64(bb*17)/255
			return r, g, b, 1, true
		}
		if len(h) == 6 {
			var rr, gg, bb byte
			if _, err := fmt.Sscanf(h, "%2x%2x%2x", &rr, &gg, &bb); err != nil {
				return 0, 0, 0, 0, false
			}
			return float64(rr) / 255, float64(gg) / 255, float64(bb) / 255, 1, true
		}
		return 0, 0, 0, 0, false
	case strings.HasPrefix(css, "rgb"):
		var rr, gg, bb int
		if _, err := fmt.Sscanf(strings.TrimPrefix(strings.TrimPrefix(css, "rgba"), "rgb"), "(%d, %d, %d", &rr, &gg, &bb); err != nil {
			return 0, 0, 0, 0, false
		}
		a = 1
		if ai := strings.Index(css, ","); ai >= 0 {
			rest := css[ai+1:]
			if bi := strings.Index(rest, ","); bi >= 0 {
				rest2 := rest[bi+1:]
				if ci := strings.Index(rest2, ","); ci >= 0 {
					fmt.Sscanf(rest2[ci+1:], "%f", &a)
				}
			}
		}
		return float64(rr) / 255, float64(gg) / 255, float64(bb) / 255, a, true
	}
	return 0, 0, 0, 0, false
}
