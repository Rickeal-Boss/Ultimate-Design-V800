#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
参考包贴图吸色（像素级取色，不复制像素进项目）

用途：为程序化石材生成器定色板。只输出统计值（占面积比 / 中位色 / 明暗分位），
不产出任何图像文件，不构成对贴图的重分发。

用法：
  python tools/ref_palette.py <texture.png> [...]  [--json out.json]
"""
import argparse
import json
import os
import sys

try:
    from PIL import Image
except Exception as e:  # noqa: BLE001
    print("[!] 需要 Pillow：%s" % e)
    sys.exit(1)


def hexs(rgb):
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(c)))) for c in rgb)


def analyse(path, colors=6, crop=0.6):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    cw, ch = int(w * crop), int(h * crop)
    im = im.crop(((w - cw) // 2, (h - ch) // 2, (w + cw) // 2, (h + ch) // 2))
    small = im.resize((256, 256), Image.LANCZOS)
    q = small.quantize(colors=colors, method=Image.MEDIANCUT)
    pal = q.getpalette()
    counts = q.getcolors()
    counts.sort(reverse=True)
    total = 256 * 256
    out = []
    for cnt, idx in counts:
        rgb = pal[idx * 3: idx * 3 + 3]
        out.append({"hex": hexs(rgb), "rgb": rgb, "share": round(cnt / total, 4)})
    # 明暗分位（亮度）
    px = list(small.getdata())
    lum = sorted(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] for p in px)
    pct = {k: hexs([0, 0, 0]) for k in ()}
    def at(f):
        return lum[int(f * (len(lum) - 1))]
    p = {k: round(at(v), 1) for k, v in
         {"p05": 0.05, "p25": 0.25, "p50": 0.50, "p75": 0.75, "p95": 0.95}.items()}
    med = px[len(px) // 2]
    # 暖冷倾向：R-B 差
    warm = sum(p[0] - p[2] for p in px) / len(px)
    sat = sum(max(p) - min(p) for p in px) / len(px)
    return {
        "file": os.path.basename(path),
        "size": [w, h],
        "dominant": out,
        "lum_pct": p,
        "median_rgb": list(med),
        "median_hex": hexs(med),
        "warm_bias_R-B": round(warm, 2),
        "mean_sat": round(sat, 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", default="")
    ap.add_argument("--colors", type=int, default=6)
    args = ap.parse_args()
    res = []
    for f in args.files:
        try:
            r = analyse(f, args.colors)
        except Exception as e:  # noqa: BLE001
            print("[!] %s: %s" % (f, e))
            continue
        res.append(r)
        print("=" * 96)
        print("%s  %dx%d  中位 %s  R-B %+.1f  meanSat %.1f" % (
            r["file"], r["size"][0], r["size"][1], r["median_hex"], r["warm_bias_R-B"], r["mean_sat"]))
        print("  亮度分位 " + "  ".join("%s=%.0f" % (k, v) for k, v in r["lum_pct"].items()))
        for d in r["dominant"]:
            bar = "█" * max(1, int(d["share"] * 40))
            print("  %s %-9s %5.1f%%  %s" % (d["hex"], str(tuple(d["rgb"])), d["share"] * 100, bar))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=1)
        print("\nJSON → %s" % args.json)


if __name__ == "__main__":
    main()
