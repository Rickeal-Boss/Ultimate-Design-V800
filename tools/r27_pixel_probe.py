"""R27 像素探针 · 世界坐标投影版（projection-aware）。

把 (worldX, worldY, worldZ) 用针孔投影映射到 1280x720 画面坐标再取区域中位色，
避免手估画面区域打错位置（deck_driver 的「城堡白」采样就曾混入拱洞暗区）。

机位定义与 .qa/r27_env_final.mjs 的 VIEWS 表保持一致。
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2] / "brake-v800"
OUT = ROOT / "verify" / "r27_final"

W, H = 1280, 720

# VIEWS: name -> (ex, ey, ez, tx, ty, tz, fovDeg)
VIEWS = {
    "deck_driver": (0, 1.8, 30, 0, 4.0, -260, 62),
    "viaduct_side": (300, 120, -180, 0, -5, -180, 55),
    "arch_close": (42, 13, -100, -2, 3, -168, 55),
    "gate_front": (0, 10, -300, 0, 24, -358.5, 60),
    "tunnel_drive": (0, 1.6, -340, 0, 2.5, -400, 65),
    "inner_street": (0, 3.0, -420, 0, 8.0, -800, 62),
    "aerial": (120, 160, 60, 0, 0, -500, 50),
}

REF = {
    "sky_zenith(#494c5d)": (0x49, 0x4C, 0x5D, 77),
    "sky_left(#61585d)": (0x61, 0x58, 0x5D, 90),
    "horizon_glow(#beb098)": (0xBE, 0xB0, 0x98, 177),
    "tower_lit(#ded2c0)": (0xDE, 0xD2, 0xC0, 211),
    "tower_backlit(#4a4441)": (0x4A, 0x44, 0x41, 69),
    "wing_shadow(#5c5554)": (0x5C, 0x55, 0x54, 86),
    "road(#393431)": (0x39, 0x34, 0x31, 53),
    "gate_arch(#171310)": (0x17, 0x13, 0x10, 20),
    "gold_mid(#a38455)": (0xA3, 0x84, 0x55, 134),
    "cliff(#665a4d)": (0x66, 0x5A, 0x4D, 92),
}


def lum(p):
    return round(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])


def project(view, p):
    """世界点 -> 画面 (px, py)。针孔模型，返回 None 表示在相机背后。"""
    ex, ey, ez, tx, ty, tz, fov = view
    # 相机基
    fwd = (tx - ex, ty - ey, tz - ez)
    fl = math.sqrt(sum(c * c for c in fwd))
    fwd = tuple(c / fl for c in fwd)
    up = (0.0, 1.0, 0.0)
    right = (
        fwd[1] * up[2] - fwd[2] * up[1],
        fwd[2] * up[0] - fwd[0] * up[2],
        fwd[0] * up[1] - fwd[1] * up[0],
    )
    rl = math.sqrt(sum(c * c for c in right))
    if rl < 1e-6:
        right = (1.0, 0.0, 0.0)
    else:
        right = tuple(c / rl for c in right)
    up2 = (
        right[1] * fwd[2] - right[2] * fwd[1],
        right[2] * fwd[0] - right[0] * fwd[2],
        right[0] * fwd[1] - right[1] * fwd[0],
    )
    d = (p[0] - ex, p[1] - ey, p[2] - ez)
    z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]
    if z <= 0.5:
        return None
    x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2]
    y = d[0] * up2[0] + d[1] * up2[1] + d[2] * up2[2]
    halfFovV = math.radians(fov) / 2
    halfFovH = math.atan(math.tan(halfFovV) * W / H)
    if abs(x / z) >= math.tan(halfFovH) * 0.98 or abs(y / z) >= math.tan(halfFovV) * 0.98:
        return None
    px = W / 2 + (x / z) / math.tan(halfFovH) * (W / 2)
    py = H / 2 - (y / z) / math.tan(halfFovV) * (H / 2)
    return (px, py)


def med(im, cx, cy, r=6):
    box = (int(cx - r), int(cy - r), int(cx + r), int(cy + r))
    crop = im.crop(box).convert("RGB")
    px = sorted(crop.getdata(), key=lambda p: sum(p))
    return px[len(px) // 2]


def main():
    print("== 参考采样（tonemap 后） ==")
    for k, v in REF.items():
        print(f"  {k:28s} L={v[3]}")
    print()

    # (view, 说明, 世界点) —— 世界点都选在对应材质的实心处
    samples = [
        # ── gate_front：城门楼 58.5m 外，构件大而清晰 ──
        ("gate_front", "左塔前脸(背光)", (-13.75, 20, -351.5)),
        ("gate_front", "左塔前脸上部", (-13.75, 34, -351.5)),
        ("gate_front", "门洞拱内(暗)", (0, 6, -351.5)),
        ("gate_front", "拱上白石体量", (0, 36, -358.5)),
        ("gate_front", "顶层金带(拱脚带)", (0, 8.4, -351.75)),
        ("gate_front", "金券(右侧弧)", (8.6, 14, -351.5)),
        ("gate_front", "金饰圆盘", (0, 33.5, -351.85)),
        ("gate_front", "天空顶部", None),
        ("gate_front", "地平线(城门后)", None),
        # ── deck_driver：车视 ──
        ("deck_driver", "路面中心", (0, 0, 100)),
        ("deck_driver", "栏板金压顶", (16.36, 2.1, 100)),
        ("deck_driver", "灯柱火盆(金)", (16.17, 5.6, 38)),
        ("deck_driver", "天空顶部", None),
        ("deck_driver", "崖体(左)", (-24.7, 8, -60)),
        # ── viaduct_side ──
        ("viaduct_side", "天空顶部", None),
        ("viaduct_side", "桥体白(侧面)", (0, -6, -180)),
        # ── aerial ──
        ("aerial", "天空顶部", None),
    ]

    for vname, label, p in samples:
        f = OUT / f"{vname}.png"
        if not f.exists():
            print(f"[skip] {vname}")
            continue
        im = Image.open(f)
        view = VIEWS[vname]
        if p is None:
            # 天空/地平线：直接取画面坐标
            if "天空" in label:
                cx, cy = 640, 30
            else:
                cx, cy = 640, 300
        else:
            r = project(view, p)
            if r is None:
                print(f"  {vname:13s} {label:16s} [不在画面内]")
                continue
            cx, cy = r
        m = med(im, cx, cy)
        print(
            f"  {vname:13s} {label:16s} px=({cx:4.0f},{cy:4.0f})  "
            f"#{m[0]:02x}{m[1]:02x}{m[2]:02x} L={lum(m):3d} R-B={m[0]-m[2]:+d}"
        )


if __name__ == "__main__":
    sys.exit(main())
