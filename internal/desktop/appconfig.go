// appconfig.go — AppConfig wails 服务:应用配置与项目索引的文件持久化,
// 实现收敛在 internal/appcfg;前端经 Call.ByName("desktop.AppConfig.*") 调用,
// 纯 web 态自动回退 localStorage(见 frontend core/store/persistence)。
package desktop

import "git.gorun.fun/share/goder/internal/appcfg"

// AppConfig wails 服务(配置文件 + 每个 scope 的项目索引)。
type AppConfig struct{}

// Load 读取应用配置(不存在时返回默认值)。
func (a *AppConfig) Load() (appcfg.Config, error) {
	return appConfigStore().Load()
}

// Save 落盘应用配置。
func (a *AppConfig) Save(cfg appcfg.Config) error {
	return appConfigStore().Save(cfg)
}

// LoadIndex 读取某个 scope 的项目索引 JSON(结构由前端全权定义)。
func (a *AppConfig) LoadIndex(scope string) (string, error) {
	return appConfigStore().LoadIndex(scope)
}

// SaveIndex 写入某个 scope 的项目索引 JSON。
func (a *AppConfig) SaveIndex(scope string, indexJSON string) error {
	return appConfigStore().SaveIndex(scope, indexJSON)
}
