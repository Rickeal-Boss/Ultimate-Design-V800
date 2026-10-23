#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R27 · 参考包贴图 albedo 吸色（统计值，不复制像素进项目）

与 tools/ref_palette.py 的分工：
  ref_palette.py 给「中位色 + 主色板 + 亮度分位」（够看基色）；
  本脚本补 R27 环境重建真正需要的三条：
    1) 逐通道 p05 / p50 / p95（定 roughness/albedo 的明暗带宽，不是单点色）
    2) 鎏金占比 gold_share（R>G>B 且 R-B≥40 且 S≥0.25）→ 决定金饰要不要单独材质
    3) 高频细节对比度 detail_contrast（局部梯度均值）→ 决定程序化噪声强度

铁律 31：这些是贴图 albedo（未 tonemap），可直接当 material.color 用；
        参考渲染图（已 tonemap + 曝光）只能用来判断氛围，不能取色。

用法：
  python tools/r27_palette.py <tex.png> [...] --json .qa/r27_palette.json
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image


def hexs(rgb):
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(c)))) for c in rgb)


def analyse(path, crop=0.7, side=512):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    cw, ch = int(w * crop), int(h * crop)
    im = im.crop(((w - cw) // 2, (h - ch) // 2, (w + cw) // 2, (h + ch) // 2))
    small = im.resize((side, side), Image.LANCZOS)
    a = np.asarray(small).astype(np.float32)          # [S,S,3] RGB
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.2126 * R + 0.7152 * G + 0.0722 * B
    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    gold = (R > G) & (G >= B) & ((R - B) >= 40) & (sat >= 0.25) & (lum >= 40)
    # 局部对比：3×3 差分均值（衡量贴图噪声/砖缝强度）
    gx = np.abs(np.diff(lum, axis=1)).mean()
    gy = np.abs(np.diff(lum, axis=0)).mean()
    q = lambda x, p: float(np.percentile(x, p))
    out = {
        "file": os.path.basename(path),
        "size": [w, h],
        "crop": crop,
        "rgb_p05": [round(q(R, 5), 1), round(q(G, 5), 1), round(q(B, 5), 1)],
        "rgb_p50": [round(q(R, 50), 1), round(q(G, 50), 1), round(q(B, 50), 1)],
        "rgb_p95": [round(q(R, 95), 1), round(q(G, 95), 1), round(q(B, 95), 1)],
        "median_hex": hexs([q(R, 50), q(G, 50), q(B, 50)]),
        "p05_hex": hexs([q(R, 5), q(G, 5), q(B, 5)]),
        "p95_hex": hexs([q(R, 95), q(G, 95), q(B, 95)]),
        "lum_p05_p50_p95": [round(q(lum, 5), 1), round(q(lum, 50), 1), round(q(lum, 95), 1)],
        "mean_sat": round(float(sat.mean()), 3),
        "warm_bias_R_minus_B": round(float((R - B).mean()), 2),
        "gold_share": round(float(gold.mean()), 4),
        "detail_contrast": round(float((gx + gy) / 2), 2),
        # 主色板（中位切分 6 色）
        "dominant": [],
    }
    qz = small.quantize(colors=6, method=Image.MEDIANCUT)
    pal = np.array(qz.getpalette()[:18]).reshape(6, 3)
    counts = sorted(qz.getcolors(), reverse=True)
    total = side * side
    for cnt, idx in counts:
        out["dominant"].append({"hex": hexs(pal[idx]), "rgb": [int(x) for x in pal[idx]],
                                "share": round(cnt / total, 4)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", default=".qa/r27_palette.json")
    ap.add_argument("--crop", type=float, default=0.7)
    args = ap.parse_args()
    res = []
    for f in args.files:
        try:
            r = analyse(f, args.crop)
        except Exception as e:  # noqa: BLE001
            print("[!] %s: %s" % (f, e))
            continue
        res.append(r)
        print("%-46s %5dx%-5d med %s  p05 %s  p95 %s  gold %5.1f%%  sat %.2f  dC %5.1f" % (
            r["file"][:45], r["size"][0], r["size"][1], r["median_hex"], r["p05_hex"], r["p95_hex"],
            r["gold_share"] * 100, r["mean_sat"], r["detail_contrast"]))
    if args.json:
        os.makedirs(os.path.dirname(args.json) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=1)
        print("\nJSON → %s" % args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
