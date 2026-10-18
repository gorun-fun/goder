// agentskills.go — AgentConfig 服务的技能面:~/.grf/skills/<name>/SKILL.md
// 的发现/读/写/启停与内置技能的启动烙写(单一源文件 agentskills/ 经
// go:embed 就近嵌入)。DTO 与前端 host/bridge.ts 手工对齐。
package desktop

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// SkillDTO 与前端 host/bridge.ts 的 SkillDTO 对齐。
type SkillDTO struct {
	Name        string `json:"name"` // 技能名(skills/ 下的目录名)
	Description string `json:"description"`
	Path        string `json:"path"` // SKILL.md 绝对路径(展示用)
	// Disabled:true = 已禁用(SKILL.md 改名为 SKILL.md.disabled,内容保留)
	Disabled bool `json:"disabled"`
}

// SkillsDTO 与前端 host/bridge.ts 的 SkillsDTO 对齐。
type SkillsDTO struct {
	Path     string     `json:"path"` // skills 目录绝对路径(展示用)
	Skills   []SkillDTO `json:"skills"`
	Writable bool       `json:"writable"`
}

// skillsDir 解析技能目录。
func skillsDir() string {
	return filepath.Join(grfHome(), "skills")
}

// SkillsLoad 列出 ~/.grf/skills/<name>/SKILL.md(名称排序;含已禁用项)。
func (a *AgentConfig) SkillsLoad() SkillsDTO {
	dir := skillsDir()
	out := SkillsDTO{Path: dir, Skills: []SkillDTO{}, Writable: settingsWritable(dir)}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range ents {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		md := filepath.Join(dir, e.Name(), "SKILL.md")
		disabled := false
		if _, err := os.Stat(md); err != nil {
			// SKILL.md 不存在:看是否被禁用(SKILL.md.disabled)
			if _, err2 := os.Stat(filepath.Join(dir, e.Name(), "SKILL.md.disabled")); err2 != nil {
				continue
			}
			md = filepath.Join(dir, e.Name(), "SKILL.md.disabled")
			disabled = true
		}
		raw, err := os.ReadFile(md)
		if err != nil {
			continue
		}
		out.Skills = append(out.Skills, SkillDTO{
			Name:        e.Name(),
			Description: skillDescription(string(raw)),
			Path:        md,
			Disabled:    disabled,
		})
	}
	sort.Slice(out.Skills, func(i, j int) bool { return out.Skills[i].Name < out.Skills[j].Name })
	return out
}

// skillDescription 提取技能描述:优先 YAML frontmatter 的 description:,
// 否则取正文首个非标题非空行(截断到 80 字)。
func skillDescription(md string) string {
	lines := strings.Split(md, "\n")
	inFront := false
	for _, ln := range lines {
		t := strings.TrimSpace(ln)
		if t == "---" && !inFront {
			inFront = true
			continue
		}
		if inFront {
			if t == "---" || t == "..." {
				inFront = false
			} else if v, ok := strings.CutPrefix(t, "description:"); ok {
				if s := strings.Trim(strings.TrimSpace(v), `"'`); s != "" {
					return truncateRunes(s, 80)
				}
			}
			continue
		}
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		return truncateRunes(t, 80)
	}
	return ""
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// SkillSetEnabled 启用/禁用技能:gh 只认 SKILL.md,禁用即改名
// SKILL.md.disabled(内容保留),启用改回。
func (a *AgentConfig) SkillSetEnabled(name string, enabled bool) error {
	if err := validSkillName(name); err != nil {
		return err
	}
	dir := filepath.Join(skillsDir(), name)
	on := filepath.Join(dir, "SKILL.md")
	off := filepath.Join(dir, "SKILL.md.disabled")
	if enabled {
		if _, err := os.Stat(off); err != nil {
			if _, err2 := os.Stat(on); err2 == nil {
				return nil // 已是启用态
			}
			return os.ErrNotExist
		}
		return os.Rename(off, on)
	}
	if _, err := os.Stat(on); err != nil {
		if _, err2 := os.Stat(off); err2 == nil {
			return nil // 已是禁用态
		}
		return os.ErrNotExist
	}
	return os.Rename(on, off)
}

// SkillGet 读取技能全文;目录穿越防护(禁止名字带路径分隔符)。
func (a *AgentConfig) SkillGet(name string) (string, error) {
	if err := validSkillName(name); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(skillsDir(), name, "SKILL.md"))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// SkillSave 新建/覆盖技能(建目录 + 写 SKILL.md)。内置技能由启动烙写
// 管理,不接受编辑(前端设置页对内置技能只读)。
func (a *AgentConfig) SkillSave(name, content string) error {
	if err := validSkillName(name); err != nil {
		return err
	}
	if _, ok := builtinSkills[name]; ok {
		return fmt.Errorf("内置技能 %s 不可编辑", name)
	}
	dir := filepath.Join(skillsDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o600)
}

// SkillDelete 删除技能目录(SKILL.md 所在目录整体移除);内置技能拒绝。
func (a *AgentConfig) SkillDelete(name string) error {
	if err := validSkillName(name); err != nil {
		return err
	}
	if _, ok := builtinSkills[name]; ok {
		return fmt.Errorf("内置技能 %s 不可删除", name)
	}
	dir := filepath.Join(skillsDir(), name)
	if _, err := os.Stat(dir); err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// validSkillName 技能名即目录名:非空且不含路径分隔符/向上引用。
func validSkillName(name string) error {
	if name == "" || strings.ContainsRune(name, '/') || strings.ContainsRune(name, '\\') || name == "." || name == ".." {
		return &skillNameError{name}
	}
	return nil
}

type skillNameError struct{ name string }

func (e *skillNameError) Error() string { return "非法技能名:" + e.name }

// ---------- 内置技能(启动烙写,单一源文件) ----------

//go:embed agentskills/goder-auto.md
var goderAutoSkillMD string

// builtinSkills 内置技能:name → SKILL.md 全文。goder-auto 是自动化操作员
// 的创作指南:源文件 internal/desktop/agentskills/goder-auto.md 同时被前端
// 两个 vite 配置以 define 常量 __GODER_AUTO_SKILL_MD__ 注入 core(进操作员
// system_prompt,创建自动化会话即全文生效),改指南只改这一份,不要另建拷贝。
var builtinSkills = map[string]string{"goder-auto": goderAutoSkillMD}

// ServiceStartup wails 启动钩子:确保内置技能落盘(gh server 若已按旧
// 清单起跑,重启 gh 后生效)。失败只降级告警,不阻断 app 启动。
func (a *AgentConfig) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	for name, content := range builtinSkills {
		if err := ensureBuiltinSkill(name, content); err != nil {
			log.Printf("[agent] 内置技能 %s 落盘失败(重启后会重试): %v", name, err)
		}
	}
	// 内置技能 grf-auto 更名 goder-auto 的 alpha 迁移:清掉旧名目录,
	// 避免技能列表里新旧两份指南并存(旧目录只剩过时正文,无用户数据)。
	if err := os.RemoveAll(filepath.Join(skillsDir(), "grf-auto")); err != nil {
		log.Printf("[agent] 旧内置技能 grf-auto 清理失败(不影响使用): %v", err)
	}
	return nil
}

// ensureBuiltinSkill 幂等落盘一个内置技能:SKILL.md 缺失或内容与内置版
// 不一致时写入;用户已禁用(SKILL.md.disabled)则尊重,不做任何改动。
func ensureBuiltinSkill(name, content string) error {
	dir := filepath.Join(skillsDir(), name)
	on := filepath.Join(dir, "SKILL.md")
	if raw, err := os.ReadFile(on); err == nil && string(raw) == content {
		return nil
	}
	if _, err := os.Stat(filepath.Join(dir, "SKILL.md.disabled")); err == nil {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(on, []byte(content), 0o600)
}
