//! 服务（AI 站点）定义与内置列表迁移。
//!
//! 与 Electron 版 main.js 的 DEFAULT_SERVICES / SERVICES_VERSION 保持同源：
//! 同一份 config.json 两边都要能读，所以字段名一个都不能改。

use serde::{Deserialize, Serialize};

/// 内置站点列表的版本：数字变了就会在下次启动时把新增的内置站点补给老配置。
///   1 -> 最初的 4 个（deepseek / chatgpt / claude / coze）
///   2 -> 扣子换成豆包，新增 Kimi、智谱 GLM、Gemini，并带上内置 logo
pub const SERVICES_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Service {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: String,
    /// 用户自己加的站点。内置站点升级时不碰它们。
    #[serde(default)]
    pub custom: bool,
    /// 从顶栏收起：服务和登录态都留着，只是不在标签栏上占位。
    #[serde(default)]
    pub hidden: bool,
}

impl Service {
    fn builtin(id: &str, name: &str, url: &str, color: &str, icon: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            url: url.into(),
            color: color.into(),
            icon: icon.into(),
            custom: false,
            hidden: false,
        }
    }
}

pub fn default_services() -> Vec<Service> {
    vec![
        Service::builtin("deepseek", "DeepSeek", "https://chat.deepseek.com/", "#4d6bfe", "deepseek"),
        Service::builtin("chatgpt", "ChatGPT", "https://chatgpt.com/", "#10a37f", "chatgpt"),
        Service::builtin("claude", "Claude", "https://claude.ai/", "#d97757", "claude"),
        Service::builtin("doubao", "豆包", "https://www.doubao.com/chat/", "#2f7cf6", "doubao"),
        Service::builtin("kimi", "Kimi", "https://www.kimi.com/", "#1f2329", "kimi"),
        Service::builtin("glm", "智谱 GLM", "https://chatglm.cn/", "#3b5bfd", "chatglm"),
        Service::builtin("gemini", "Gemini", "https://gemini.google.com/app", "#4285f4", "gemini"),
    ]
}

pub struct Migration {
    pub services: Vec<Service>,
    pub removed_ids: Vec<String>,
    pub notes: Vec<String>,
}

/// 把老配置里的内置站点升级到当前的 default_services()。
/// 只动「内置且没被用户改过」的服务，用户自己加的一律保持原样。
pub fn migrate(services: Vec<Service>, from_version: u32) -> Migration {
    let mut notes = Vec::new();
    let mut removed_ids = Vec::new();
    if from_version >= SERVICES_VERSION {
        return Migration { services, removed_ids, notes };
    }

    let defaults = default_services();
    let builtin_ids: Vec<&str> = defaults.iter().map(|s| s.id.as_str()).collect();

    // 1) 内置的「扣子」在新版里由「豆包」取代
    let mut list: Vec<Service> = services
        .into_iter()
        .filter(|svc| {
            let is_builtin_coze = svc.id == "coze" && !svc.custom;
            if is_builtin_coze {
                removed_ids.push(svc.id.clone());
                notes.push("扣子已由豆包取代".to_string());
            }
            !is_builtin_coze
        })
        .collect();

    // 2) 补上本版新增的内置站点（用户删过的不强行加回来——只按 id 不存在来判断）
    for def in defaults.iter() {
        if !list.iter().any(|s| s.id == def.id) {
            notes.push(format!("新增内置站点：{}", def.name));
            list.push(def.clone());
        }
    }

    // 3) 给老配置里没有 icon/color 的内置站点补上
    for svc in list.iter_mut() {
        if svc.custom || !builtin_ids.contains(&svc.id.as_str()) {
            continue;
        }
        if let Some(def) = defaults.iter().find(|d| d.id == svc.id) {
            if svc.icon.is_empty() {
                svc.icon = def.icon.clone();
            }
            if svc.color.is_empty() {
                svc.color = def.color.clone();
            }
        }
    }

    Migration { services: list, removed_ids, notes }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_config_gets_doubao_instead_of_coze() {
        let old = vec![
            Service::builtin("deepseek", "DeepSeek", "https://chat.deepseek.com/", "", ""),
            Service::builtin("coze", "扣子", "https://www.coze.cn/", "", ""),
        ];
        let out = migrate(old, 1);
        assert!(!out.services.iter().any(|s| s.id == "coze"), "扣子应被移除");
        assert!(out.services.iter().any(|s| s.id == "doubao"), "豆包应被补上");
        assert_eq!(out.removed_ids, vec!["coze".to_string()], "扣子的分区目录要进待清理列表");
    }

    #[test]
    fn custom_services_survive_migration() {
        let old = vec![Service {
            id: "mine".into(), name: "我的".into(), url: "https://example.com/".into(),
            color: "#fff".into(), icon: String::new(), custom: true, hidden: false,
        }];
        let out = migrate(old, 1);
        let mine = out.services.iter().find(|s| s.id == "mine").expect("自定义站点不该丢");
        assert_eq!(mine.name, "我的");
        assert!(mine.custom);
    }

    #[test]
    fn migration_is_idempotent_at_current_version() {
        let list = default_services();
        let out = migrate(list.clone(), SERVICES_VERSION);
        assert_eq!(out.services, list, "已经是当前版本时不该改动任何东西");
        assert!(out.notes.is_empty());
    }
}
