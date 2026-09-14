//! 分屏几何：把「窗口宽度 + 每栏占比」算成每个 webview 的像素矩形。
//!
//! 这是整个迁移里最容易出错的一块——Electron 版是 main.js 的 computeGeometry /
//! dragDivider / normalizeWeights，语义必须逐条对齐，包括 Math.round 的半数进位行为
//! （JS 的 Math.round 和 Rust 的 f64::round 对正数都是「.5 向上」，可以直接对应）。
//!
//! 纯函数，不碰窗口、不碰状态——所以能被单元测试全覆盖。

use serde::Serialize;

pub const TAB_BAR_HEIGHT: i32 = 44; // 与 index.html 里 #bar 的高度保持一致
pub const SPLIT_GAP: i32 = 4; // 两栏之间的缝隙
pub const DIVIDER_HIT_PAD: i32 = 5; // 拖动热区向两侧外扩
pub const MIN_PANE_WIDTH: f64 = 260.0; // 单栏最小宽度（拖动下限）
pub const MAX_PANES: usize = 4; // 最多同时显示几栏
pub const MIN_SANE_WIDTH: i32 = 200;
pub const MIN_SANE_HEIGHT: i32 = 150;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PaneRect {
    pub id: String,
    pub index: usize,
    pub x: i32,
    pub width: i32,
    /// 相对内容区顶边（不含标签栏）。一维分栏时恒为 0。
    pub y: i32,
    pub height: i32,
}

/// 分屏怎么摆。
///
/// 1 栏铺满；2 栏左右；3 栏是「左边一整栏 + 右边上下两格」；
/// 4 栏是田字格 2×2。这是用户明确要的形状，不是自动推导出来的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum GridShape {
    Single,
    Columns,   // 横向平铺（2 栏时的默认）
    OneTwo,    // 左 1 + 右 2
    Quad,      // 田字格 2x2
}

impl GridShape {
    /// 按栏数挑默认形状。
    pub fn for_count(n: usize) -> Self {
        match n {
            0 | 1 => GridShape::Single,
            2 => GridShape::Columns,
            3 => GridShape::OneTwo,
            _ => GridShape::Quad,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Divider {
    pub index: usize,
    pub x: i32,
    pub width: i32,
    #[serde(rename = "hitX")]
    pub hit_x: i32,
    #[serde(rename = "hitWidth")]
    pub hit_width: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Geometry {
    pub panes: Vec<PaneRect>,
    pub dividers: Vec<Divider>,
    pub usable: i32,
}

/// 去掉缝隙之后，真正能分给各栏的宽度。
pub fn usable_width(width: i32, count: usize) -> i32 {
    let gaps = count.saturating_sub(1) as i32 * SPLIT_GAP;
    (width - gaps).max(0)
}

/// 把任意权重数组归一化成 count 个和为 1 的正数；全空/全零时退回等分。
pub fn normalize_weights(weights: Option<&[f64]>, count: usize) -> Vec<f64> {
    let n = count.max(1);
    let mut list: Vec<f64> = weights
        .unwrap_or(&[])
        .iter()
        .take(n)
        .map(|w| if w.is_finite() && *w > 0.0 { *w } else { 0.0 })
        .collect();
    list.resize(n, 0.0);
    let sum: f64 = list.iter().sum();
    if !(sum > 0.0) {
        return vec![1.0 / n as f64; n];
    }
    list.into_iter().map(|w| w / sum).collect()
}

/// 按当前占比算出每栏的矩形（一维横向平铺）。
/// 最后一栏吃掉舍入误差，保证右边缘严格贴合窗口。
pub fn compute_geometry(width: i32, pane_ids: &[String], weights: &[f64]) -> Geometry {
    compute_grid(width, 0, pane_ids, weights, GridShape::Columns)
}

/// 按形状把 N 个服务摆成网格。
///
/// height 传 0 时退化成一维（只算 x/width，y/height 恒为 0），
/// 老的横向分栏调用方不用改。要田字格就传真实高度 + GridShape::Quad。
pub fn compute_grid(
    width: i32,
    height: i32,
    pane_ids: &[String],
    weights: &[f64],
    shape: GridShape,
) -> Geometry {
    let n = pane_ids.len();
    if n == 0 {
        return Geometry { panes: Vec::new(), dividers: Vec::new(), usable: width.max(0) };
    }

    // 二维形状需要真实高度；拿不到就退回横向平铺，总比算出 0 高的视图强
    let two_d = height > 0 && matches!(shape, GridShape::OneTwo | GridShape::Quad) && n >= 3;
    if !two_d {
        return columns_geometry(width, height, pane_ids, weights);
    }

    let gap = SPLIT_GAP;
    let half_w = (width - gap) / 2;
    let right_w = width - gap - half_w; // 右列吃掉舍入误差，右边缘严格贴合
    let half_h = (height - gap) / 2;
    let bottom_h = height - gap - half_h;

    let mut panes = Vec::with_capacity(n);
    let mut push = |index: usize, x: i32, y: i32, w: i32, h: i32| {
        panes.push(PaneRect {
            id: pane_ids[index].clone(),
            index,
            x,
            y,
            width: w.max(0),
            height: h.max(0),
        });
    };

    match shape {
        // 左边一整栏，右边上下两格
        GridShape::OneTwo => {
            push(0, 0, 0, half_w, height);
            push(1, half_w + gap, 0, right_w, half_h);
            if n > 2 {
                push(2, half_w + gap, half_h + gap, right_w, bottom_h);
            }
        }
        // 田字格：左上、右上、左下、右下
        GridShape::Quad => {
            push(0, 0, 0, half_w, half_h);
            push(1, half_w + gap, 0, right_w, half_h);
            if n > 2 {
                push(2, 0, half_h + gap, half_w, bottom_h);
            }
            if n > 3 {
                push(3, half_w + gap, half_h + gap, right_w, bottom_h);
            }
        }
        _ => unreachable!("two_d 已经排除了这些形状"),
    }

    // 网格模式下暂不提供拖动分隔条（要分别处理横竖两组，先把布局做对）
    Geometry { panes, dividers: Vec::new(), usable: width.max(0) }
}

/// 横向平铺：原来的一维实现。
fn columns_geometry(width: i32, height: i32, pane_ids: &[String], weights: &[f64]) -> Geometry {
    let n = pane_ids.len().max(1);
    let usable = usable_width(width, n);
    let mut panes = Vec::with_capacity(pane_ids.len());
    let mut x = 0i32;
    let mut used = 0i32;

    for (index, id) in pane_ids.iter().enumerate() {
        let last = index == n - 1;
        let w = if last {
            (usable - used).max(0)
        } else {
            let ratio = weights.get(index).copied().unwrap_or(0.0);
            ((usable as f64 * ratio).round() as i32).max(0)
        };
        panes.push(PaneRect { id: id.clone(), index, x, width: w, y: 0, height: height.max(0) });
        x += w + SPLIT_GAP;
        used += w;
    }

    let dividers = panes
        .iter()
        .take(panes.len().saturating_sub(1))
        .enumerate()
        .map(|(index, pane)| Divider {
            index,
            x: pane.x + pane.width,
            width: SPLIT_GAP,
            hit_x: pane.x + pane.width - DIVIDER_HIT_PAD,
            hit_width: SPLIT_GAP + DIVIDER_HIT_PAD * 2,
        })
        .collect();

    Geometry { panes, dividers, usable }
}

/// 拖动第 index 条分隔条到客户区坐标 client_x。
/// 只调整相邻两栏的占比，两者之和不变；两侧都不小于 MIN_PANE_WIDTH。
/// 返回 None 表示这次拖动无效（栏数不足 / 宽度退化），调用方应保持原样。
pub fn drag_divider(width: i32, weights: &[f64], index: usize, client_x: f64) -> Option<Vec<f64>> {
    let n = weights.len();
    if n < 2 {
        return None;
    }
    let i = index.min(n - 2);
    let usable = usable_width(width, n);
    if usable <= 0 {
        return None;
    }
    let usable_f = usable as f64;

    let mut out = weights.to_vec();
    let before: f64 = out[..i].iter().sum();
    let pair = out[i] + out[i + 1];
    let pair_left = usable_f * before + i as f64 * SPLIT_GAP as f64;
    let min_ratio = (pair / 2.0).min(MIN_PANE_WIDTH / usable_f);

    let mut left_ratio = (client_x - pair_left) / usable_f;
    if !left_ratio.is_finite() {
        return None;
    }
    left_ratio = left_ratio.max(min_ratio).min(pair - min_ratio);

    out[i] = left_ratio;
    out[i + 1] = pair - left_ratio;
    Some(out)
}

/// 相邻两栏回到等分（双击分隔条）。
pub fn equalize_divider(weights: &[f64], index: usize) -> Option<Vec<f64>> {
    let n = weights.len();
    if n < 2 {
        return None;
    }
    let i = index.min(n - 2);
    let mut out = weights.to_vec();
    let pair = out[i] + out[i + 1];
    out[i] = pair / 2.0;
    out[i + 1] = pair / 2.0;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("s{i}")).collect()
    }

    #[test]
    fn single_pane_fills_the_window() {
        let g = compute_geometry(1200, &ids(1), &[1.0]);
        assert_eq!(g.panes.len(), 1);
        assert_eq!(g.panes[0].x, 0);
        assert_eq!(g.panes[0].width, 1200, "独栏应铺满，没有缝隙可扣");
        assert!(g.dividers.is_empty(), "一栏不该有分隔条");
    }

    #[test]
    fn right_edge_is_flush_despite_rounding() {
        // 宽度和权重都选成除不尽的，验证最后一栏吃掉舍入误差
        for width in [1001, 1237, 1920, 777] {
            let w = normalize_weights(Some(&[1.0, 1.0, 1.0]), 3);
            let g = compute_geometry(width, &ids(3), &w);
            let last = g.panes.last().unwrap();
            assert_eq!(last.x + last.width, width, "宽度 {width}：右边缘必须严格贴合窗口");
        }
    }

    #[test]
    fn gaps_are_exactly_split_gap_wide() {
        let w = normalize_weights(Some(&[2.0, 1.0]), 2);
        let g = compute_geometry(900, &ids(2), &w);
        let gap = g.panes[1].x - (g.panes[0].x + g.panes[0].width);
        assert_eq!(gap, SPLIT_GAP, "两栏之间的空隙必须正好是 SPLIT_GAP");
    }

    #[test]
    fn divider_hit_area_straddles_the_gap() {
        let g = compute_geometry(900, &ids(2), &normalize_weights(None, 2));
        let d = &g.dividers[0];
        assert_eq!(d.hit_x, d.x - DIVIDER_HIT_PAD, "热区应向左外扩");
        assert_eq!(d.hit_width, SPLIT_GAP + DIVIDER_HIT_PAD * 2, "热区应比缝隙两边各宽 PAD");
    }

    #[test]
    fn normalize_falls_back_to_even_split() {
        assert_eq!(normalize_weights(None, 4), vec![0.25; 4]);
        assert_eq!(normalize_weights(Some(&[0.0, 0.0]), 2), vec![0.5, 0.5], "全零退回等分");
        assert_eq!(
            normalize_weights(Some(&[f64::NAN, 1.0]), 2),
            vec![0.0, 1.0],
            "NaN 当作 0，不该污染整个数组"
        );
    }

    #[test]
    fn normalize_always_sums_to_one() {
        let w = normalize_weights(Some(&[3.0, 1.0, 1.0]), 3);
        assert!((w.iter().sum::<f64>() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn drag_respects_min_pane_width() {
        let w = normalize_weights(None, 2); // [0.5, 0.5]
        let width = 1000;
        // 想把分隔条拖到最左边（x=0），左栏应被 MIN_PANE_WIDTH 顶住
        let out = drag_divider(width, &w, 0, 0.0).expect("两栏拖动应有效");
        let usable = usable_width(width, 2) as f64;
        assert!(
            out[0] * usable >= MIN_PANE_WIDTH - 1.0,
            "左栏被拖到 {}px，不该小于最小宽度 {}",
            out[0] * usable,
            MIN_PANE_WIDTH
        );
        assert!((out[0] + out[1] - (w[0] + w[1])).abs() < 1e-12, "两栏之和必须守恒");
    }

    #[test]
    fn drag_conserves_pair_sum_at_both_extremes() {
        let w = normalize_weights(Some(&[1.0, 1.0, 1.0]), 3);
        for x in [-500.0, 0.0, 300.0, 5000.0] {
            let out = drag_divider(1200, &w, 1, x).expect("三栏第二条分隔条应可拖");
            assert!(
                (out[1] + out[2] - (w[1] + w[2])).abs() < 1e-12,
                "x={x} 时这一对栏的总占比必须守恒"
            );
            assert!((out[0] - w[0]).abs() < 1e-12, "x={x} 时不相邻的第一栏不该被动到");
        }
    }

    #[test]
    fn drag_is_rejected_when_geometry_is_degenerate() {
        assert!(drag_divider(1000, &[1.0], 0, 100.0).is_none(), "单栏没有分隔条可拖");
        assert!(drag_divider(0, &[0.5, 0.5], 0, 10.0).is_none(), "零宽窗口应拒绝拖动");
    }

    #[test]
    fn drag_index_is_clamped_not_panicking() {
        let w = normalize_weights(None, 2);
        let out = drag_divider(1000, &w, 99, 400.0).expect("越界索引应被夹住而不是崩溃");
        assert_eq!(out.len(), 2);
    }

    // ---------------- 网格布局 ----------------

    #[test]
    fn quad_tiles_the_window_without_gaps_or_overflow() {
        let g = compute_grid(1000, 800, &ids(4), &[], GridShape::Quad);
        assert_eq!(g.panes.len(), 4);
        // 右边缘和下边缘都要严格贴合，不能留缝也不能溢出
        let right = g.panes.iter().map(|p| p.x + p.width).max().unwrap();
        let bottom = g.panes.iter().map(|p| p.y + p.height).max().unwrap();
        assert_eq!(right, 1000, "右边缘必须贴合窗口");
        assert_eq!(bottom, 800, "下边缘必须贴合窗口");
    }

    #[test]
    fn quad_cells_do_not_overlap() {
        let g = compute_grid(1001, 777, &ids(4), &[], GridShape::Quad);
        for (i, a) in g.panes.iter().enumerate() {
            for b in g.panes.iter().skip(i + 1) {
                let x_apart = a.x + a.width <= b.x || b.x + b.width <= a.x;
                let y_apart = a.y + a.height <= b.y || b.y + b.height <= a.y;
                assert!(x_apart || y_apart, "格子 {} 和 {} 重叠了", a.index, b.index);
            }
        }
    }

    #[test]
    fn quad_positions_are_top_left_top_right_bottom_left_bottom_right() {
        let g = compute_grid(1000, 800, &ids(4), &[], GridShape::Quad);
        let p = &g.panes;
        assert!(p[0].x < p[1].x && p[0].y == p[1].y, "0=左上 1=右上");
        assert!(p[2].x == p[0].x && p[2].y > p[0].y, "2=左下");
        assert!(p[3].x == p[1].x && p[3].y == p[2].y, "3=右下");
    }

    #[test]
    fn one_two_puts_a_full_height_column_on_the_left() {
        let g = compute_grid(1000, 800, &ids(3), &[], GridShape::OneTwo);
        assert_eq!(g.panes[0].height, 800, "左栏应通高");
        assert_eq!(g.panes[0].y, 0);
        assert!(g.panes[1].y < g.panes[2].y, "右边两格上下排列");
        assert_eq!(
            g.panes[1].y + g.panes[1].height + SPLIT_GAP,
            g.panes[2].y,
            "右边两格之间要正好留一条缝"
        );
    }

    #[test]
    fn grid_falls_back_to_columns_without_a_real_height() {
        // 高度拿不到时（窗口最小化等）退回横向平铺，总比算出 0 高的视图强
        let g = compute_grid(1000, 0, &ids(4), &normalize_weights(None, 4), GridShape::Quad);
        assert!(g.panes.iter().all(|p| p.y == 0), "退化时应全部在同一行");
    }

    #[test]
    fn shape_for_count_matches_the_intended_layouts() {
        assert_eq!(GridShape::for_count(1), GridShape::Single);
        assert_eq!(GridShape::for_count(2), GridShape::Columns);
        assert_eq!(GridShape::for_count(3), GridShape::OneTwo);
        assert_eq!(GridShape::for_count(4), GridShape::Quad);
    }

    #[test]
    fn columns_still_behave_as_before() {
        // 老的一维路径不能因为加了网格而变味
        let w = normalize_weights(Some(&[1.0, 1.0, 1.0]), 3);
        let g = compute_geometry(1200, &ids(3), &w);
        let last = g.panes.last().unwrap();
        assert_eq!(last.x + last.width, 1200);
        assert_eq!(g.dividers.len(), 2, "横向平铺仍然有分隔条");
    }

    #[test]
    fn empty_pane_list_yields_nothing() {
        let g = compute_grid(1000, 800, &[], &[], GridShape::Quad);
        assert!(g.panes.is_empty());
        assert!(g.dividers.is_empty());
    }

    #[test]
    fn equalize_only_touches_the_pair() {
        let w = normalize_weights(Some(&[4.0, 2.0, 2.0]), 3);
        let out = equalize_divider(&w, 1).unwrap();
        assert!((out[0] - w[0]).abs() < 1e-12, "第一栏不该被动到");
        assert!((out[1] - out[2]).abs() < 1e-12, "这一对应当等分");
        assert!((out.iter().sum::<f64>() - 1.0).abs() < 1e-12, "总和仍为 1");
    }
}
