// version.go — 版本号比较的单一实现(本包内所有择新排序共用)。
//
// ⚠ 三处同套语义,改比较规则时三处同改并用矩阵用例验证:
//  1. 桌面端本文件(原 ghdownload.go)的 compareVersion;
//  2. 发版推算 scripts/version.sh 的 ver_max(awk);
//  3. CI 捆绑 gh 下载(调 sh scripts/version.sh gh)。
//
// 不要用 sort -V 替代:它把正式版排在预发布之下且 postN 按字符串比。
// 版本形态 X.Y.Z[-预发布.N][.postM]:预发布递进 alpha < beta < rc < 正式
// (无后缀);同基线再发版追加 .postN(高于该基线、低于下一基线)。
package desktop

import (
	"regexp"
	"strconv"
	"strings"
)

// compareVersion 比较 dotted 版本号(sort -V 语义的修正版,兼容 semver 式
// 预发布):按 "." 分段,缺段补 "0"(1 与 1.0 相等)。段比较规则见
// compareVersionSeg —— 关键点:数字段带连字符预发布后缀(1-alpha)时,
// 无后缀的裸数字段(正式版 1)排在其上;而 X 与 X.postN 这类"纯字母数字
// 混排段"按自然序(postN 的数字后缀按数值比)。对本项目已发布的
// 0.0.1-alpha.N[.postM] 形态,新旧规则结果完全相同;新规则额外保证:
//
//	0.0.1-alpha.14 < 0.0.1-beta.1 < 0.0.1-rc.1 < 0.0.1(正式版)
//	0.0.1-alpha.14 < 0.0.1-alpha.14.post9 < ...post11(维持不变)
func compareVersion(a, b string) int {
	as := strings.Split(strings.TrimPrefix(a, "v"), ".")
	bs := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		av, bv := "0", "0" // 缺段补 "0":1 与 1.0 相等
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		if c := compareVersionSeg(av, bv); c != 0 {
			return c
		}
	}
	return 0
}

// compareVersionSeg 比较单个 "." 段。
// 结构化路径:两侧都是"数字前缀[-连字符后缀]"形态(如 1、14、1-alpha)时,
// 数字前缀按数值比;相同时无后缀(正式)大于有后缀(预发布),后缀之间
// 自然序比(alpha < beta < rc)。其余形态(post11 等混排段)整体自然序比。
func compareVersionSeg(x, y string) int {
	if x == y {
		return 0
	}
	xn, xs := splitNumHyphen(x)
	yn, ys := splitNumHyphen(y)
	if xn != "" && yn != "" {
		if c := compareNumericStr(xn, yn); c != 0 {
			return c
		}
		switch {
		case xs == "" && ys == "":
			return 0
		case xs == "":
			return 1 // 正式版段 > 预发布段
		case ys == "":
			return -1
		}
		return natCompare(xs, ys)
	}
	return natCompare(x, y)
}

// splitNumHyphen 拆出"数字前缀 + 连字符后缀":
// "14" → ("14","");"1-alpha" → ("1","alpha");非该形态 → ("",原串)。
func splitNumHyphen(s string) (num, suffix string) {
	if isDigitRun(s) {
		return s, ""
	}
	if i := strings.IndexByte(s, '-'); i > 0 && isDigitRun(s[:i]) {
		return s[:i], s[i+1:]
	}
	return "", s
}

// compareNumericStr 比较两个纯数字串(去前导零后先按位数再字典序)。
func compareNumericStr(x, y string) int {
	x, y = strings.TrimLeft(x, "0"), strings.TrimLeft(y, "0")
	if len(x) != len(y) {
		if len(x) < len(y) {
			return -1
		}
		return 1
	}
	return strings.Compare(x, y)
}

// verTokenRe 自然序比较的最小词:连续数字或连续非数字。
var verTokenRe = regexp.MustCompile(`[0-9]+|[^0-9]+`)

// natCompare 自然序比较:逐词比,数字词按数值比、非数字词按字符串比;
// 数字词排在非数字词前(post9 < post11 的数值序、0 < post0 的补位序
// 都由此成立)。
func natCompare(x, y string) int {
	xt := verTokenRe.FindAllString(x, -1)
	yt := verTokenRe.FindAllString(y, -1)
	for i := 0; i < len(xt) || i < len(yt); i++ {
		var xv, yv string
		if i < len(xt) {
			xv = xt[i]
		}
		if i < len(yt) {
			yv = yt[i]
		}
		if xv == yv {
			continue
		}
		xd, yd := isDigitRun(xv), isDigitRun(yv)
		switch {
		case xd && yd:
			if c := compareNumericStr(xv, yv); c != 0 {
				return c
			}
		case xd:
			return -1
		case yd:
			return 1
		default:
			if c := strings.Compare(xv, yv); c != 0 {
				return c
			}
		}
	}
	return 0
}

// isDigitRun 整串是否为数字(verTokenRe 的词要么全数字要么全非数字)。
func isDigitRun(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// ---------- 本地构建版本的择新比较 ----------

// gh 本地构建(build.sh 经 git describe 注入)的版本带开发后缀:
// "<基线tag>-<提交数>-g<hash>[-dirty]",表示基线发布版之上又有本地提交,
// 应比基线新。compareVersion 会把该后缀当普通连字符段、排到基线之下,
// 这里先剥掉再比较基线,基线相同时基线之上提交数多者新。
//
// 注意与"三处同套语义"的关系(version.sh / CI 只见发布版号):下载服务器
// 与发布目录里的版本永不含开发后缀,本层只影响本地候选之间的择新
// (resolveGh 的托管副本 vs 捆绑/本机副本)与 updater 的 gh 更新判定,
// 发布版本之间的排序仍完全走 compareVersion,语义不变。

// ghDevSuffixRe 版本尾部的 git describe 开发后缀。
var ghDevSuffixRe = regexp.MustCompile(`(?:-(\d+)-g[0-9a-f]+)?(?:-dirty)?$`)

// splitGhDevSuffix 剥掉开发后缀,返回基线与基线之上的提交数(无后缀为 0)。
func splitGhDevSuffix(v string) (baseline string, commits int) {
	m := ghDevSuffixRe.FindStringSubmatch(v)
	if m == nil {
		return v, 0
	}
	if m[1] != "" {
		commits, _ = strconv.Atoi(m[1])
	}
	return v[:len(v)-len(m[0])], commits
}

// compareGhVersion 比较两个 gh 版本(含本地构建的开发后缀),语义:
// 基线不同按 compareVersion;基线相同,基线之上提交数多者新。
func compareGhVersion(a, b string) int {
	ba, na := splitGhDevSuffix(a)
	bb, nb := splitGhDevSuffix(b)
	if c := compareVersion(ba, bb); c != 0 {
		return c
	}
	switch {
	case na < nb:
		return -1
	case na > nb:
		return 1
	}
	return 0
}
