//! 配置持久化。
//!
//! 刻意沿用 Electron 版的同一个文件：%APPDATA%/Aihub/config.json。
//! 服务列表、分屏布局、主题、快捷键都能被 Tauri 版直接继承，用户不用重配。
//!
//! 注意：**登录态继承不了**。Electron 存在 userData/Partitions/<id>（Chromium 分区格式），
//! Tauri 走 WebView2 的用户数据目录，两者的 cookie 存储格式和加密方式都不同。
//! 迁移后所有站点需要重新登录一次，这是换运行时的硬代价。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::layout::{normalize_weights, MAX_PANES};
use crate::services::{default_services, migrate, Service, SERVICES_VERSION};

pub const CONFIG_VERSION: u32 = 4; // 3 -> 4：新增 always_on_top / tab_bar_visible
pub const HIBERNATE_CHOICES: [u32; 3] = [15, 30, 120];
pub const HIBERNATE_DEFAULT_MINUTES: u32 = 30;
pub const HOTKEY_DEFAULT: &str = "Alt+Space";

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HibernateConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_hibernate_minutes")]
    pub minutes: u32,
}

fn default_hibernate_minutes() -> u32 {
    HIBERNATE_DEFAULT_MINUTES
}

impl Default for HibernateConfig {
    fn default() -> Self {
        Self { enabled: true, minutes: HIBERNATE_DEFAULT_MINUTES }
    }
}

impl HibernateConfig {
    fn normalize(mut self) -> Self {
        if !HIBERNATE_CHOICES.contains(&self.minutes) {
            self.minutes = HIBERNATE_DEFAULT_MINUTES;
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HotkeyConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_accelerator")]
    pub accelerator: String,
    #[serde(default = "default_action")]
    pub action: String,
    /// 唤出时临时置顶，窗口切到后台自动取消。
    /// 和常驻的 Config::always_on_top 是两件事，别合并。
    #[serde(rename = "pinTop", default = "default_true")]
    pub pin_top: bool,
    #[serde(rename = "closeToTray", default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default = "default_true")]
    pub tray: bool,
}

fn default_accelerator() -> String {
    HOTKEY_DEFAULT.to_string()
}

fn default_action() -> String {
    "toggle".to_string()
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            accelerator: default_accelerator(),
            action: default_action(),
            pin_top: true,
            close_to_tray: true,
            tray: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub version: u32,
    #[serde(rename = "servicesVersion", default)]
    pub services_version: u32,
    #[serde(default = "default_services")]
    pub services: Vec<Service>,
    #[serde(rename = "activeId", default)]
    pub active_id: String,
    #[serde(default)]
    pub panes: Vec<String>,
    #[serde(default)]
    pub weights: Vec<f64>,
    #[serde(rename = "lastUrls", default)]
    pub last_urls: HashMap<String, String>,
    #[serde(rename = "pendingWipe", default)]
    pub pending_wipe: Vec<String>,
    #[serde(default)]
    pub preload: bool,
    #[serde(default)]
    pub hibernate: HibernateConfig,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub hotkey: HotkeyConfig,

    // ---- v4 新增 ----
    /// 常驻置顶。用户明确要求默认开启（「窗口默认要置顶才行系统的顶」）。
    #[serde(rename = "alwaysOnTop", default = "default_true")]
    pub always_on_top: bool,
    /// 标签栏是否显示。关掉之后站点视图铺满整个窗口。
    #[serde(rename = "tabBarVisible", default = "default_true")]
    pub tab_bar_visible: bool,
}

fn default_theme() -> String {
    "system".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            services_version: SERVICES_VERSION,
            services: default_services(),
            active_id: String::new(),
            panes: Vec::new(),
            weights: Vec::new(),
            last_urls: HashMap::new(),
            pending_wipe: Vec::new(),
            preload: false,
            hibernate: HibernateConfig::default(),
            theme: default_theme(),
            hotkey: HotkeyConfig::default(),
            always_on_top: true,
            tab_bar_visible: true,
        }
    }
}

impl Config {
    pub fn get_service(&self, id: &str) -> Option<&Service> {
        self.services.iter().find(|s| s.id == id)
    }

    /// 标签栏上看得见的服务（没被收起的）。
    pub fn visible_services(&self) -> Vec<&Service> {
        self.services.iter().filter(|s| !s.hidden).collect()
    }

    /// 站点视图的顶边：标签栏藏起来时就是 0，视图铺满整窗。
    pub fn content_top(&self) -> i32 {
        if self.tab_bar_visible {
            crate::layout::TAB_BAR_HEIGHT
        } else {
            0
        }
    }

    /// 读进来之后把所有能自愈的字段修正一遍。
    /// 原则：宁可退回默认值，也不让一个坏字段把应用卡死在启动阶段。
    pub fn normalize(&mut self) {
        let from_version = if self.services_version == 0 { 1 } else { self.services_version };
        let migration = migrate(std::mem::take(&mut self.services), from_version);
        self.services = migration.services;
        for id in migration.removed_ids {
            if !self.pending_wipe.contains(&id) {
                self.pending_wipe.push(id);
            }
        }
        if self.services.is_empty() {
            self.services = default_services();
        }
        self.services_version = SERVICES_VERSION;

        self.hibernate = std::mem::take(&mut self.hibernate).normalize();
        if !["dark", "light", "system"].contains(&self.theme.as_str()) {
            self.theme = default_theme();
        }
        if self.hotkey.accelerator.trim().is_empty() {
            self.hotkey.accelerator = default_accelerator();
        }
        if !["toggle", "show"].contains(&self.hotkey.action.as_str()) {
            self.hotkey.action = default_action();
        }

        // 分屏：只保留还存在且没被收起的服务，最多 MAX_PANES 栏
        let known: Vec<String> = self.services.iter().map(|s| s.id.clone()).collect();
        let mut panes: Vec<String> = Vec::new();
        for id in std::mem::take(&mut self.panes) {
            if known.contains(&id) && !panes.contains(&id) && panes.len() < MAX_PANES {
                panes.push(id);
            }
        }

        // 焦点栏必须存在，且必须在布局里
        if !known.contains(&self.active_id) {
            self.active_id = self
                .visible_services()
                .first()
                .map(|s| s.id.clone())
                .or_else(|| known.first().cloned())
                .unwrap_or_default();
        }
        if panes.is_empty() && !self.active_id.is_empty() {
            panes.push(self.active_id.clone());
        }
        if !self.active_id.is_empty() && !panes.contains(&self.active_id) {
            if panes.len() < MAX_PANES {
                panes.push(self.active_id.clone());
            } else {
                let last = panes.len() - 1;
                panes[last] = self.active_id.clone();
            }
        }

        let count = panes.len();
        self.panes = panes;
        // 栏数变了就重新归一化，不然权重和栏数对不上会算出零宽视图
        self.weights = if self.weights.len() == count {
            normalize_weights(Some(&self.weights), count)
        } else {
            normalize_weights(None, count)
        };
        self.version = CONFIG_VERSION;
    }
}

/// 配置目录：沿用 Electron 版的 %APPDATA%/Aihub，好让老配置直接被继承。
pub fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Aihub")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// 某个服务的 WebView2 用户数据目录。
/// Electron 版用的是 userData/Partitions/<id>，这里刻意换一个目录名：
/// 两套运行时的存储格式不兼容，放一起只会互相污染。
pub fn partition_dir(id: &str) -> PathBuf {
    config_dir().join("WebViews").join(id)
}

pub fn load() -> Config {
    let path = config_path();
    let mut config = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Config>(&text) {
            Ok(cfg) => cfg,
            Err(err) => {
                // 坏配置不能让应用起不来：备份一份再用默认值继续
                eprintln!("[aihub] 配置无法解析，已备份为 config.json.bad: {err}");
                let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                Config::default()
            }
        },
        Err(_) => Config::default(),
    };
    config.normalize();
    config
}

pub fn save(config: &Config) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let text = serde_json::to_string_pretty(config)?;
    // 先写临时文件再原子替换：写到一半断电也不会留下半个 config.json
    let tmp = dir.join("config.json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, config_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_gets_all_defaults() {
        let mut cfg: Config = serde_json::from_str("{}").expect("空对象应能反序列化");
        cfg.normalize();
        assert_eq!(cfg.services.len(), 7, "应补齐 7 个内置站点");
        assert!(cfg.always_on_top, "置顶默认开启（用户明确要求）");
        assert!(cfg.tab_bar_visible, "标签栏默认显示");
        assert_eq!(cfg.version, CONFIG_VERSION);
        assert_eq!(cfg.panes.len(), 1, "至少要有一栏");
    }

    #[test]
    fn v3_config_is_inherited_not_reset() {
        // 模拟 Electron 版写出的 v3 配置：没有 alwaysOnTop / tabBarVisible 字段
        let raw = r#"{
            "version": 3, "servicesVersion": 2, "activeId": "claude",
            "panes": ["claude", "chatgpt"], "weights": [0.6, 0.4],
            "theme": "dark", "preload": true,
            "hibernate": {"enabled": false, "minutes": 15}
        }"#;
        let mut cfg: Config = serde_json::from_str(raw).expect("v3 配置应能读进来");
        cfg.normalize();
        assert_eq!(cfg.theme, "dark", "老主题要保留");
        assert!(cfg.preload, "老的预加载偏好要保留");
        assert!(!cfg.hibernate.enabled, "老的休眠开关要保留");
        assert_eq!(cfg.hibernate.minutes, 15);
        assert_eq!(cfg.panes, vec!["claude", "chatgpt"], "老布局要保留");
        assert!(cfg.always_on_top, "缺失的新字段走默认值，而不是让整份配置作废");
    }

    #[test]
    fn panes_are_capped_and_deduped() {
        let mut cfg = Config::default();
        cfg.panes = vec!["deepseek".into(), "deepseek".into(), "chatgpt".into(),
                         "claude".into(), "doubao".into(), "kimi".into(), "glm".into()];
        cfg.active_id = "deepseek".into();
        cfg.normalize();
        assert!(cfg.panes.len() <= MAX_PANES, "最多 {MAX_PANES} 栏");
        let mut sorted = cfg.panes.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), cfg.panes.len(), "不能有重复栏");
    }

    #[test]
    fn unknown_pane_ids_are_dropped() {
        let mut cfg = Config::default();
        cfg.panes = vec!["ghost".into(), "claude".into()];
        cfg.active_id = "claude".into();
        cfg.normalize();
        assert!(!cfg.panes.contains(&"ghost".to_string()), "不存在的服务不该留在布局里");
        assert!(cfg.panes.contains(&"claude".to_string()));
    }

    #[test]
    fn weights_always_match_pane_count() {
        let mut cfg = Config::default();
        cfg.panes = vec!["claude".into(), "chatgpt".into(), "kimi".into()];
        cfg.active_id = "claude".into();
        cfg.weights = vec![0.9]; // 和栏数对不上
        cfg.normalize();
        assert_eq!(cfg.weights.len(), cfg.panes.len(), "权重个数必须等于栏数");
        assert!((cfg.weights.iter().sum::<f64>() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn active_id_is_forced_into_the_layout() {
        let mut cfg = Config::default();
        cfg.panes = vec!["claude".into()];
        cfg.active_id = "gemini".into();
        cfg.normalize();
        assert!(cfg.panes.contains(&"gemini".to_string()), "焦点栏必须出现在布局里");
    }

    #[test]
    fn content_top_follows_tab_bar_visibility() {
        let mut cfg = Config::default();
        assert_eq!(cfg.content_top(), crate::layout::TAB_BAR_HEIGHT);
        cfg.tab_bar_visible = false;
        assert_eq!(cfg.content_top(), 0, "藏起标签栏后站点应铺满整窗");
    }

    #[test]
    fn bad_theme_and_hotkey_fall_back() {
        let mut cfg = Config::default();
        cfg.theme = "neon".into();
        cfg.hotkey.accelerator = "   ".into();
        cfg.hotkey.action = "explode".into();
        cfg.normalize();
        assert_eq!(cfg.theme, "system");
        assert_eq!(cfg.hotkey.accelerator, HOTKEY_DEFAULT);
        assert_eq!(cfg.hotkey.action, "toggle");
    }
}
