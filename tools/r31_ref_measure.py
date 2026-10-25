#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R31 Phase 3 前置 · 参考图像素量测（秦核源 landing-review，只读参考图，产物入 .qa/r31_review/）

输入：
  REF_MAIN  = C:/Users/16896/.workbuddy/clipboard-images/clipboard-2026-10-24T15-28-00-169Z-6211d46b.jpg
              （全景正立面：白城堡群 + 御桥 + 逆光暴云，1080x607）
  REF_KIT   = C:/Users/16896/.workbuddy/clipboard-images/clipboard-2026-10-24T15-28-00-168Z-ef9ac9a5.jpg
              （构件库四视图：高塔/矮墙/门楼/窄塔，1080x607，紫底棚拍）

量测：
  1) 立面竖向体量带：主构图区（城堡群 x∈[60,1000]）行均亮度 + 一阶差分峰 → 檐口/楼层线
  2) 金色占比与分布：HSV 阈值（H∈[0.06,0.13] S>0.35 V>0.30，即黄金/黄铜色域）→
     全图占比、逐列/逐行占比曲线的峰结构（验证「竖向为骨、水平为节」），
     并落盘金色掩膜叠加图 gold_map.png
  3) 石材明度分布与缝隙对比：取 4 个纯墙面窗口（主殿左塔身/左翼墙/桥栏下矮墙/右塔身），
     输出 L 的 p05/p50/p95、(p95-p05)、局部梯度 |∇L| 的 p50/p95（缝隙读感）、
     行/列亮度均值的 FFT 主周期（板块尺寸读感）
  4) 关键比例（目视锚点 + 非空像素 bbox 自动化）：
     - 构件库四构件各自 bbox（对紫底做色度分割）→ 塔宽/塔高
     - 全景图中央钟楼 bbox（非天像素）→ 塔宽/塔高
     - 桥面宽（画面底缘两侧栏杆间亮带）/ 立面总宽（城堡群 bbox）
  输出 .qa/r31_review/ref_metrics.json + 控制台摘要
"""
import json
import os
import numpy as np
from PIL import Image

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".qa", "r31_review")
os.makedirs(OUT_DIR, exist_ok=True)
REF_MAIN = r"C:/Users/16896/.workbuddy/clipboard-images/clipboard-2026-10-24T15-28-00-169Z-6211d46b.jpg"
REF_KIT = r"C:/Users/16896/.workbuddy/clipboard-images/clipboard-2026-10-24T15-28-00-168Z-ef9ac9a5.jpg"

main = np.asarray(Image.open(REF_MAIN).convert("RGB"), dtype=np.float32) / 255.0
kit = np.asarray(Image.open(REF_KIT).convert("RGB"), dtype=np.float32) / 255.0
H, W = main.shape[:2]


def rgb_to_hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.max(rgb, axis=-1)
    mn = np.min(rgb, axis=-1)
    d = mx - mn + 1e-9
    h = np.zeros_like(mx)
    m = (mx == r) & (d > 0)
    h[m] = ((g - b)[m] / d[m]) % 6
    m = (mx == g) & (d > 0)
    h[m] = (b - r)[m] / d[m] + 2
    m = (mx == b) & (d > 0)
    h[m] = (r - g)[m] / d[m] + 4
    h = h / 6
    s = d / (mx + 1e-9)
    v = mx
    return h, s, v


h, s, v = rgb_to_hsv(main)
L = 0.2126 * main[..., 0] + 0.7152 * main[..., 1] + 0.0722 * main[..., 2]

# ── 2) 金色掩膜 ──────────────────────────────────────────────
gold = (h > 0.06) & (h < 0.135) & (s > 0.32) & (v > 0.28) & (v < 0.98)
gold_ratio = float(gold.mean())
col_prof = gold.mean(axis=0)  # 每列金色占比（竖向为骨 → 列曲线多峰、峰窄）
row_prof = gold.mean(axis=1)  # 每行占比（水平为节 → 行曲线在檐口/楼层带有宽峰）


def peaks(prof, thr, min_gap=8):
    idx = np.where(prof > thr)[0]
    if len(idx) == 0:
        return []
    groups, cur = [], [idx[0]]
    for i in idx[1:]:
        if i - cur[-1] <= 2:
            cur.append(i)
        else:
            groups.append(cur)
            cur = [i]
    groups.append(cur)
    pk = [(int(np.mean(g)), float(prof[g].max())) for g in groups if len(g) >= 2]
    pk = [p for p in pk if p[1] >= thr]
    pk.sort(key=lambda x: -x[1])
    out = []
    for c, a in pk:
        if all(abs(c - o) > min_gap for o, _ in out):
            out.append((c, a))
    return out[:16]


col_peaks = peaks(col_prof, max(0.04, float(col_prof.max()) * 0.35))
row_peaks = peaks(row_prof, max(0.05, float(row_prof.max()) * 0.45))

# 金色掩膜叠加图落盘
overlay = (main * 0.45).copy()
overlay[gold] = overlay[gold] * 0.4 + np.array([1.0, 0.78, 0.1]) * 0.6
Image.fromarray((np.clip(overlay, 0, 1) * 255).astype(np.uint8)).save(
    os.path.join(OUT_DIR, "ref_gold_map.png"))

# ── 1) 竖向体量带（行均亮度，主构图区） ────────────────────
band = L[:, 60:1000]
row_mean = band.mean(axis=1)
grad = np.abs(np.diff(row_mean))
band_edges = peaks(grad, max(0.006, float(grad.max()) * 0.25), min_gap=6)

# ── 3) 石材统计窗口（手工锚定：参考图 1080x607）─────────────
stone_windows = {
    # 名称: (x0, y0, x1, y1)  —— 左塔身/左翼墙矮墙/右塔身/中央基座墙（1280x720 实测坐标）
    "left_tower_body": (178, 261, 284, 391),
    "left_wall_low": (71, 510, 237, 593),
    "right_tower_body": (1019, 308, 1126, 427),
    "center_base_wall": (450, 510, 557, 581),
}
gy, gx = np.gradient(L)
gm = np.hypot(gx, gy)


def stats_of(x0, y0, x1, y1):
    w = L[y0:y1, x0:x1]
    g = gm[y0:y1, x0:x1]
    rowm = w.mean(axis=1)
    # 主周期：行均亮度的自相关峰位置（板层高度读感，px）
    rm = rowm - rowm.mean()
    ac = np.correlate(rm, rm, "full")[len(rm) - 1:]
    ac = ac / (ac[0] + 1e-9)
    lag = 0
    for i in range(4, min(len(ac) - 1, 60)):
        if ac[i] > ac[i - 1] and ac[i] > ac[i + 1] and ac[i] > 0.2:
            lag = i
            break
    return {
        "p05": float(np.percentile(w, 5)),
        "p50": float(np.percentile(w, 50)),
        "p95": float(np.percentile(w, 95)),
        "span_p95_p05": float(np.percentile(w, 95) - np.percentile(w, 5)),
        "grad_p50": float(np.percentile(g, 50)),
        "grad_p95": float(np.percentile(g, 95)),
        "row_cycle_px": lag,
    }


stone = {k: stats_of(*v) for k, v in stone_windows.items()}

# ── 4) 关键比例 ─────────────────────────────────────────────
# 4a. 构件库四构件（紫底分割 + 手工 x 窗口；实测 1280x720，列占位 runs
#     [112,620]/[648,1016]/[1046,1150]，tall_tower 与 low_wall 同段再手分）：
kh, ks, kv = rgb_to_hsv(kit)
bg = (kh > 0.90) & (ks > 0.18) & (kv > 0.15) & (kv < 0.6)
fg = ~bg
KIT_WINDOWS = {
    "tall_tower": (112, 0, 300, 720),
    "low_wall": (320, 0, 620, 720),
    "gatehouse": (648, 0, 1016, 720),
    "narrow_tower": (1046, 0, 1150, 720),
}
kit_parts = []
for nm, (a, ya, b, yb) in KIT_WINDOWS.items():
    sub = fg[ya:yb, a:b]
    rows = np.where(sub.any(axis=1))[0]
    kit_parts.append({
        "name": nm, "x": [int(a), int(b)],
        "y": [int(rows.min()), int(rows.max())],
        "w_px": int(b - a), "h_px": int(rows.max() - rows.min() + 1),
        "w_over_h": round((b - a) / (rows.max() - rows.min() + 1), 3),
    })

# 4b. 全景中央钟楼：x∈[560,723]（1080 系 [470,610] × 1.185）、y<560（桥面以上）非天 bbox
cent = main[:560, 560:723]
ch, cs, cv = rgb_to_hsv(cent)
non_sky = ~((cs < 0.22) & (cv > 0.35) | (cv < 0.18))
rows2 = np.where(non_sky.any(axis=1))[0]
cols2 = np.where(non_sky.any(axis=0))[0]
keep = {
    "central_tower": {
        "x_window": [560, 723],
        "bbox_y": [int(rows2.min()), int(rows2.max())],
        "h_px": int(rows2.max() - rows2.min() + 1),
        "w_px": int(cols2.max() - cols2.min() + 1),
        "w_over_h": round(float(cols2.max() - cols2.min() + 1) / float(rows2.max() - rows2.min() + 1), 3),
    }
}

# 4c. 桥宽 / 立面宽：y≈690 行上暗色桥面铺装（L<0.45）过 x=640 的连续 run；
#     城堡群宽 = y∈[380,520]（门楼层）亮石列范围
rowB = L[690, :]
c0 = c1 = 640
while c0 > 0 and rowB[c0] < 0.5:
    c0 -= 1
while c1 < W - 1 and rowB[c1] < 0.5:
    c1 += 1
bridge = {"dark_run_x": [int(c0), int(c1)], "w_px": int(c1 - c0)}
bandL = L[430:500, :]
brightcols = (bandL > 0.55).sum(axis=0) > 15
runs2 = []
inr = False
for x in range(len(brightcols)):
    if brightcols[x] and not inr:
        st = x
        inr = True
    elif not brightcols[x] and inr:
        runs2.append((st, x))
        inr = False
if inr:
    runs2.append((st, len(brightcols)))
runs2 = [r for r in runs2 if r[1] - r[0] > 40]
facade = {"x": [int(runs2[0][0]), int(runs2[-1][1])], "w_px": int(runs2[-1][1] - runs2[0][0]),
          "runs": [[int(a), int(b_)] for a, b_ in runs2]}

out = {
    "images": {"main": REF_MAIN, "kit": REF_KIT, "main_shape": [H, W]},
    "gold": {
        "ratio": round(gold_ratio, 4),
        "col_peaks_px": [[c, round(a, 3)] for c, a in col_peaks],
        "row_peaks_px": [[c, round(a, 3)] for c, a in row_peaks],
        "verdict_column_vs_row": "竖向为骨" if len(col_peaks) >= len(row_peaks) else "水平为主",
        "n_col_peaks": len(col_peaks),
        "n_row_peaks": len(row_peaks),
    },
    "mass_bands": {"row_edge_peaks_px": [c for c, _ in band_edges]},
    "stone": stone,
    "kit_parts": kit_parts,
    "panorama": {**keep, "bridge_strip": bridge, "facade": facade},
    "notes": [
        "外部视觉技能（video-image-file-analysis）在本会话 Skill 注册表中不存在，双路解析降级为：内置多模态逐图目检 + PIL 分区裁剪放大 + 本脚本量化。",
        "金色 HSV 阈值 H∈[0.06,0.135] S>0.32 V∈[0.28,0.98]，已扣掉逆光高光过曝区（v<0.98）。"
    ]
}
with open(os.path.join(OUT_DIR, "ref_metrics.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print(json.dumps(out["gold"], ensure_ascii=False))
print("mass bands:", out["mass_bands"]["row_edge_peaks_px"])
for k, st in stone.items():
    print(k, st)
print("kit:", [(p["name"], p["w_over_h"]) for p in kit_parts])
print("central:", keep["central_tower"])
print("bridge:", bridge, "facade:", facade)
