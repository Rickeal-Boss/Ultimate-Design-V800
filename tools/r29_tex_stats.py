#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R29 · 参考包贴图**统计量**抽取（开发线 C：材质/贴图）

══ 法律红线（Fab Standard License + NoAI）══════════════════════════════════
本脚本**只读**参考包 png，输出的全是**标量统计量**（中位色 / 分位 / 对比度 /
颗粒尺度 / 噪声频谱 / 法线强度 / 砌缝周期与缝宽比 / 磨损分布）。
  ✅ 允许：用这些统计值**驱动**程序化生成器调参（写进 stoneTexture.ts 的参数表）。
  ❌ 禁止：把任何 png 字节、采样图块、压缩副本写进仓库或运行时；运行时不得读这些文件。
交付物必须保持「零外部资产」。本脚本不产出任何图像文件（连缩略图都不写）。

══ 输出的统计量口径 ══════════════════════════════════════════════════════
一切几何尺度都在 **A = 1024** 的归一化网格上度量（各图原生分辨率不同，
先重采样到 1024² 再比）。因此「周期 256px」= 「沿该方向 4 个砌块/图」，
这个相对量才是能直接驱动 `STONE_TILE_METERS` 与 rows/cols 的口径。

- color      : 中位色 + 每通道 p05/p50/p95 + 亮度 L 的均值/标准差/对比度
- grain      : 高通残差的径向功率谱主频 ⇒ 颗粒主波长（px@1024 + 每图周期数）
- period     : 行/列均值剖面的循环自相关 ⇒ 砌缝周期（px@1024 + 每图块数）
- normal     : |n.xy| 均值 + 等效倾角（deg）+ 法线细节能量
- masonry    : 错缝相位（复相量法）、缝宽占比（形态学闭运算基线）、磨损/污渍低频强度

用法：
  python tools/r29_tex_stats.py [--src <dir>] [--json .qa/r29_tex_stats.json] [--res 1024]
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

import numpy as np
from PIL import Image

DEFAULT_SRC = r"F:/Game/VaultCache/FabLibrary/White_castle-0ffccb05/fbx/whitecastle_fbx_extracted/WhiteCastle_FBX"
DEFAULT_JSON = ".qa/r29_tex_stats.json"

# 族归属（按文件名前缀）
FAMILY_RULES = [
    ("StoneFloor", "floor"),
    ("Wallwhite", "wall"),
    ("Wall1", "wall"),
    ("Heaven_Castle", "castle"),
    ("Details", "gold"),
    ("Rock_CliffCoastal5", "rock"),
    ("Rocks_Volume123", "rock"),
    ("DarkRockDesert", "rock"),
]

# 通道类型（按后缀）
TYPE_RULES = [
    ("_normal", "normal"),
    ("_nmap", "normal"),
    ("_gloss", "gloss"),
    ("_metalness", "metalness"),
    ("_metal", "metalness"),
    ("_albedo", "albedo"),
    ("_diff", "albedo"),
    ("_color", "albedo"),
]

ANALYSIS_RES = 1024


def hexs(rgb):
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(c)))) for c in rgb)


def classify(name):
    stem = os.path.splitext(name)[0]
    fam = "other"
    for key, val in FAMILY_RULES:
        if stem.startswith(key):
            fam = val
            break
    typ = "albedo"
    low = stem.lower()
    for key, val in TYPE_RULES:
        if low.endswith(key):
            typ = val
            break
    return fam, typ


def box_blur(a, k, axis):
    """可分离盒式均值滤波（边缘复制填充，输出与输入同形）"""
    k = int(k)
    if k <= 1:
        return a.astype(np.float64, copy=True)
    if k % 2 == 0:
        k += 1  # 对称 same-size 卷积要求奇数窗
    pad = k // 2
    if axis == 0:
        ap = np.pad(a, ((pad, pad), (0, 0)), mode="edge")
        c = np.empty((ap.shape[0] + 1, ap.shape[1]), dtype=np.float64)
        c[0] = 0.0
        np.cumsum(ap, axis=0, dtype=np.float64, out=c[1:])
        return (c[k:] - c[:-k]) / k
    ap = np.pad(a, ((0, 0), (pad, pad)), mode="edge")
    c = np.empty((ap.shape[0], ap.shape[1] + 1), dtype=np.float64)
    c[:, 0] = 0.0
    np.cumsum(ap, axis=1, dtype=np.float64, out=c[:, 1:])
    return (c[:, k:] - c[:, :-k]) / k


def _slide(a, k, axis):
    from numpy.lib.stride_tricks import sliding_window_view

    pad = k // 2
    if axis == 0:
        ap = np.pad(a, ((pad, pad), (0, 0)), mode="edge")
        v = sliding_window_view(ap, k, axis=0)[: a.shape[0], :, :]
    else:
        ap = np.pad(a, ((0, 0), (pad, pad)), mode="edge")
        v = sliding_window_view(ap, k, axis=1)[:, :, :][:, : a.shape[1], :]
    return v


def rank_filter(a, k, axis, mode):
    """可分离 min/max 滤波（sliding_window_view，比 scipy 慢但零依赖）"""
    if k <= 1:
        return a.copy()
    v = _slide(a, k, axis)
    return v.max(axis=2) if mode == "max" else v.min(axis=2)


def closing_baseline(a, k=9):
    """形态学闭运算（先膨胀后腐蚀）⇒ 抹掉细暗缝的『无缝基线』"""
    b = rank_filter(a, k, 1, "max")
    b = rank_filter(b, k, 0, "max")
    b = rank_filter(b, k, 1, "min")
    b = rank_filter(b, k, 0, "min")
    return b


def circular_autocorr(sig):
    n = sig.size
    f = np.fft.rfft(sig - sig.mean())
    ac = np.fft.irfft(f * np.conj(f), n)
    if ac[0] <= 1e-12:
        return np.zeros(n)
    return ac / ac[0]


def find_period(prof, nmin=8, nmax=None):
    """剖面循环自相关的主周期：返回 (period_px, ac_peak, blocks_per_tile, harmonics_ok)"""
    n = prof.size
    nmax = nmax or n // 2
    ac = circular_autocorr(prof)
    seg = ac[nmin:nmax]
    if seg.size < 4:
        return None, 0.0, None, False
    # 局部极大（含平台中点）
    idx = np.where((seg[1:-1] > seg[:-2]) & (seg[1:-1] >= seg[2:]))[0] + 1
    if idx.size == 0:
        j = int(np.argmax(seg))
        period = nmin + j
        return period, float(seg[j]), round(n / period, 3), False
    cand = idx[np.argsort(seg[idx])[::-1]][:6]
    best = None
    for j in sorted(cand, key=lambda j: j):
        p = nmin + int(j)
        if p * 2 < n:
            harm = float(ac[p * 2])
        else:
            harm = float(ac[p * 2 - n])
        # 偏好：自相关高 + 二次谐波也高（真周期而非噪声孤立峰）
        score = float(seg[j]) + 0.5 * max(0.0, harm)
        if best is None or score > best[0]:
            best = (score, p, float(seg[j]), harm)
    if best is None:
        return None, 0.0, None, False
    _, p, peak, harm = best
    return p, peak, round(n / p, 3), bool(harm > 0.15)


def radial_spectrum_peak(hp, res):
    """高通残差的径向平均功率谱 ⇒ 主频（cycles/tile）与颗粒主波长（px@res）"""
    f = np.fft.rfft2(hp)
    p = np.abs(f) ** 2
    ny, nx = hp.shape
    kx = np.fft.rfftfreq(nx, d=1.0 / nx)  # cycles per tile
    ky = np.fft.fftfreq(ny, d=1.0 / ny)
    kx2 = kx[None, :] ** 2
    ky2 = (ky[:, None]) ** 2
    r = np.sqrt(kx2 + ky2)
    rb = np.round(r).astype(np.int64)
    nb = int(rb.max()) + 1
    tot = np.bincount(rb.ravel(), weights=p.ravel(), minlength=nb)
    cnt = np.bincount(rb.ravel(), minlength=nb).astype(np.float64)
    prof = np.where(cnt > 0, tot / np.maximum(cnt, 1), 0.0)
    lo = max(2, int(res * 0.008))  # 排除极低频（结构层）
    hi = min(len(prof) - 1, int(res * 0.5))
    if hi <= lo:
        return None, None
    j = int(np.argmax(prof[lo:hi])) + lo
    fc = float(j)
    if fc <= 0:
        return None, None
    return fc, (res / fc)


def analyse(path, res=ANALYSIS_RES, deep=True):
    im = Image.open(path)
    native = list(im.size)
    im = im.convert("RGB")
    # 原生分辨率中心裁块（只用于高频颗粒能量，避免重采样把细颗粒洗掉）
    grain_native = None
    if deep:
        cw = min(native[0], 512)
        ch = min(native[1], 512)
        cx0 = (native[0] - cw) // 2
        cy0 = (native[1] - ch) // 2
        crop = np.asarray(im.crop((cx0, cy0, cx0 + cw, cy0 + ch)), dtype=np.float32)
        lc = 0.2126 * crop[:, :, 0] + 0.7152 * crop[:, :, 1] + 0.0722 * crop[:, :, 2]
        hp_n = lc - box_blur(box_blur(lc, 3, 0), 3, 1)
        grain_native = float(np.std(hp_n))

    small = im.resize((res, res), Image.LANCZOS)
    a = np.asarray(small, dtype=np.float32)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    l = 0.2126 * r + 0.7152 * g + 0.0722 * b

    name = os.path.basename(path)
    fam, typ = classify(name)

    out = {
        "file": name,
        "family": fam,
        "channel": typ,
        "native_size": native,
        "analysis_res": res,
    }

    # ── 色彩 ────────────────────────────────────────────────
    ch_pct = {}
    for key, arr in (("r", r), ("g", g), ("b", b)):
        q = np.percentile(arr, [5, 50, 95])
        ch_pct[key] = [round(float(v), 1) for v in q]
    med = np.array([ch_pct["r"][1], ch_pct["g"][1], ch_pct["b"][1]])
    lq = np.percentile(l, [5, 25, 50, 75, 95])
    out["median_hex"] = hexs(med)
    out["median_rgb"] = [int(round(v)) for v in med]
    out["channel_p05_p50_p95"] = ch_pct
    out["lum_pct"] = {k: round(float(v), 1) for k, v in zip(("p05", "p25", "p50", "p75", "p95"), lq)}
    out["lum_mean"] = round(float(l.mean()), 2)
    out["lum_std"] = round(float(l.std()), 2)
    out["contrast_p95_p05"] = round(float(lq[4] - lq[0]), 2)
    out["contrast_rms"] = round(float(l.std() / max(l.mean(), 1e-6)), 4)
    out["warm_bias_R_minus_B"] = round(float((r - b).mean()), 2)
    out["mean_saturation"] = round(float((a.max(axis=2) - a.min(axis=2)).mean()), 2)

    # ── 颗粒主尺度（高通残差径向功率谱）─────────────────────
    blur = box_blur(box_blur(l, 5, 0), 5, 1)
    hp = l - blur
    out["detail_std"] = round(float(hp.std()), 3)
    out["grain_std_native"] = round(grain_native, 3) if grain_native is not None else None
    try:
        fc, wl = radial_spectrum_peak(hp, res)
        out["grain_cycles_per_tile"] = round(fc, 2) if fc else None
        out["grain_wave_px"] = round(wl, 2) if wl else None
    except Exception as e:  # noqa: BLE001
        out["grain_cycles_per_tile"] = None
        out["grain_wave_px"] = None
        out["grain_error"] = str(e)[:120]

    # ── 周期性砌缝（行/列均值剖面自相关）────────────────────
    px, peak_x, bx, hx = find_period(l.mean(axis=0))
    py, peak_y, byy, hy = find_period(l.mean(axis=1))
    out["period_x_px"] = px
    out["period_x_ac"] = round(peak_x, 3)
    out["period_x_blocks"] = bx
    out["period_x_harmonic"] = hx
    out["period_y_px"] = py
    out["period_y_ac"] = round(peak_y, 3)
    out["period_y_blocks"] = byy
    out["period_y_harmonic"] = hy

    # ── 法线强度（仅 normal 通道）───────────────────────────
    if typ == "normal":
        nx = r / 255.0 * 2.0 - 1.0
        ny = g / 255.0 * 2.0 - 1.0
        nz = b / 255.0 * 2.0 - 1.0
        mag = np.sqrt(nx * nx + ny * ny)
        out["normal_mean_xy_mag"] = round(float(mag.mean()), 4)
        out["normal_p95_xy_mag"] = round(float(np.percentile(mag, 95)), 4)
        out["normal_mean_tilt_deg"] = round(float(np.degrees(np.arctan2(mag.mean(), max(nz.mean(), 1e-6)))), 2)
        out["normal_detail_std"] = round(float(mag.std()), 4)
        out["normal_z_mean"] = round(float(nz.mean()), 4)
        # 缝/倒角的真实宽度占比：法线偏离平坦的像素比例（p85 门限 = 坡面/沟槽覆盖）。
        # 比从 albedo 阈值抠暗线稳得多——它不受污渍/明度漂移影响。
        out["relief_ratio_p85"] = round(float((mag > np.percentile(mag, 85)).mean()), 4)
        # 法线自身的周期（砌缝网格在法线图里往往比 albedo 清晰）
        npx, npkx, nbx, _ = find_period(mag.mean(axis=0))
        npy, npky, nby, _ = find_period(mag.mean(axis=1))
        out["normal_period_x_px"] = npx
        out["normal_period_x_blocks"] = nbx
        out["normal_period_x_ac"] = round(npkx, 3)
        out["normal_period_y_px"] = npy
        out["normal_period_y_blocks"] = nby
        out["normal_period_y_ac"] = round(npky, 3)

    # ── 砌体结构（仅 albedo）：错缝相位 / 缝宽占比 / 磨损污渍 ──
    if typ == "albedo" and deep:
        try:
            k = 9
            base = closing_baseline(l, k)
            dark = base - l  # 细暗缝 ⇒ 正值
            # 阈值取得偏严（2σ）：宁可少捕也不把高频噪声读成缝。
            # ⚠ 实测 StoneFloor 这类低对比高噪底材该值会虚高到 0.5 —— 判"是不是真砌缝"
            #   必须看 joint_is_grid（暗缝掩膜自身的周期是否与全图周期一致），单看比值会误判。
            thr = max(3.0, float(dark.std()) * 2.0)
            mask = dark > thr
            out["joint_ratio"] = round(float(mask.mean()), 4)
            # 缝是否成网格：暗缝掩膜自身的 x/y 均值剖面周期（与全图周期一致 ⇒ 真砌缝，
            # 否则只是高频噪声被阈值误捕）
            mp = mask.astype(np.float32)
            jpx, jpkx, _, _ = find_period(mp.mean(axis=0))
            jpy, jpky, _, _ = find_period(mp.mean(axis=1))
            out["joint_mask_period_x"] = jpx
            out["joint_mask_period_x_ac"] = round(jpkx, 3)
            out["joint_mask_period_y"] = jpy
            out["joint_mask_period_y_ac"] = round(jpky, 3)
            out["joint_is_grid"] = bool(
                jpkx > 0.12 and jpx is not None and px is not None and abs(jpx - px) <= max(4, px * 0.12)
            )

            # 低频（污渍/磨损）强度：大盒滤波后 std 占全局 std 的比例
            low = box_blur(box_blur(l, 33, 0), 33, 1)
            out["lowfreq_std_ratio"] = round(float(low.std() / max(l.std(), 1e-6)), 4)
            out["lowfreq_p95_p05"] = round(float(np.percentile(low, 95) - np.percentile(low, 5)), 2)

            # 错缝：把图按水平缝分成条带，逐条带求 x 向基频复相量
            if py and py >= 8:
                bands = max(2, int(round(res / py)))
                bh = res / bands
                ph = []
                for i in range(bands):
                    y0 = int(i * bh)
                    y1 = int((i + 1) * bh)
                    if y1 - y0 < 8:
                        continue
                    band = l[y0:y1, :]
                    if px and px >= 8:
                        xs = np.arange(res, dtype=np.float64)
                        # x 向基频复相量：Z 的辐角 = 该条带竖缝图案的相位（px 内偏移）
                        z = np.exp(-2j * np.pi * xs / px)
                        prof = (band - band.mean()).mean(axis=0)
                        Z = np.sum(prof * z)
                        amp = float(np.abs(Z))
                        if amp > 1e-6:
                            phase = float(np.angle(Z))
                            ph.append(((phase / (2 * np.pi)) % 1.0, amp))
                if len(ph) >= 2:
                    fr = np.array([p[0] for p in ph])
                    # 与首条带的相位差（环形）
                    d = (fr - fr[0]) % 1.0
                    off = np.where(d > 0.5, d - 1.0, d)
                    staggered = np.abs(off) > 0.15
                    out["stagger_bands"] = int(len(ph))
                    out["stagger_ratio"] = round(float(staggered.mean()), 3)
                    if staggered.any():
                        out["stagger_offset_frac"] = round(float(np.median(np.abs(off[staggered]))), 3)
                    else:
                        out["stagger_offset_frac"] = 0.0
            # 砌块长宽比（由周期推得）
            if px and py:
                out["block_aspect_w_over_h"] = round(float(px / py), 3)
        except Exception as e:  # noqa: BLE001
            out["structure_error"] = str(e)[:160]
    return out


def aggregate(images):
    fams = {}
    for im in images:
        fams.setdefault(im["family"], []).append(im)
    out = {}
    for fam, items in sorted(fams.items()):
        alb = [i for i in items if i["channel"] == "albedo"]
        nor = [i for i in items if i["channel"] == "normal"]
        glo = [i for i in items if i["channel"] == "gloss"]
        met = [i for i in items if i["channel"] == "metalness"]
        keys = (
            "lum_mean",
            "lum_std",
            "contrast_p95_p05",
            "contrast_rms",
            "warm_bias_R_minus_B",
            "mean_saturation",
            "detail_std",
            "grain_cycles_per_tile",
            "joint_ratio",
            "lowfreq_std_ratio",
        )
        block = {"n_images": len(items), "albedo": len(alb), "normal": len(nor), "gloss": len(glo), "metalness": len(met)}
        for k in keys:
            vals = [i[k] for i in alb if i.get(k) is not None]
            if vals:
                block[k] = {
                    "median": round(float(np.median(vals)), 4),
                    "min": round(float(np.min(vals)), 4),
                    "max": round(float(np.max(vals)), 4),
                }
        if nor:
            v = [i["normal_mean_xy_mag"] for i in nor if i.get("normal_mean_xy_mag") is not None]
            t = [i["normal_mean_tilt_deg"] for i in nor if i.get("normal_mean_tilt_deg") is not None]
            if v:
                block["normal_mean_xy_mag"] = {"median": round(float(np.median(v)), 4), "min": round(float(np.min(v)), 4), "max": round(float(np.max(v)), 4)}
            if t:
                block["normal_mean_tilt_deg"] = {"median": round(float(np.median(t)), 2), "min": round(float(np.min(t)), 2), "max": round(float(np.max(t)), 2)}
        if glo:
            v = [i["lum_mean"] for i in glo]
            block["gloss_lum_mean"] = round(float(np.median(v)), 2)
            block["gloss_implied_roughness"] = round(1.0 - float(np.median(v)) / 255.0, 4)
        if met:
            v = [i["lum_mean"] for i in met]
            block["metalness_lum_mean"] = round(float(np.median(v)), 2)
            block["metalness_implied"] = round(float(np.median(v)) / 255.0, 4)
        px = [i["period_x_blocks"] for i in alb if i.get("period_x_blocks")]
        py = [i["period_y_blocks"] for i in alb if i.get("period_y_blocks")]
        if px:
            block["blocks_x_median"] = round(float(np.median(px)), 3)
        if py:
            block["blocks_y_median"] = round(float(np.median(py)), 3)
        out[fam] = block
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--json", default=DEFAULT_JSON)
    ap.add_argument("--res", type=int, default=ANALYSIS_RES)
    ap.add_argument("--deep", action="store_true", default=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    files = sorted(f for f in os.listdir(args.src) if f.lower().endswith(".png"))
    if args.limit:
        files = files[: args.limit]
    if not files:
        print("[!] 源目录没有 png：%s" % args.src)
        sys.exit(1)

    t0 = time.time()
    images = []
    for i, f in enumerate(files, 1):
        p = os.path.join(args.src, f)
        try:
            r = analyse(p, args.res, args.deep)
        except Exception as e:  # noqa: BLE001
            print("[!] %-46s FAIL %s" % (f, str(e)[:90]))
            continue
        images.append(r)
        print(
            "[%2d/%d] %-46s %-6s %-10s L%.0f±%.0f C%.0f 周期 x%s/y%s 缝%.3f"
            % (
                i,
                len(files),
                f[:46],
                r["family"],
                r["channel"],
                r["lum_mean"],
                r["lum_std"],
                r["contrast_p95_p05"],
                r["period_x_px"],
                r["period_y_px"],
                r.get("joint_ratio", -1),
            )
        )

    floor = [i for i in images if i["family"] == "floor"]
    result = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "source_dir": args.src,
        "legal_note": "仅统计量；未复制任何像素/图块/派生图像，仓库与运行时均不含参考包资产",
        "analysis_res": args.res,
        "scale_note": "所有 px 尺度均在 %d 归一化网格上度量；period 256px ⇒ 该方向 4 块/图" % args.res,
        "elapsed_s": round(time.time() - t0, 2),
        "images": images,
        "families": aggregate(images),
        "floor_detail": floor,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.json)), exist_ok=True)
    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    print("\n→ %s（%d 张，%.1fs）" % (args.json, len(images), time.time() - t0))


if __name__ == "__main__":
    main()
