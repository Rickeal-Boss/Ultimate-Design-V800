# -*- coding: utf-8 -*-
"""a1_surface_pass_geometry_fixes.py — 实测（node shim 包围盒）后的几何修正，幂等。

1) charge-pad / charge-pad-r：plane-card 轴向 bug——原 rotation [-0.25,0,0] + scale
   [x,0.004,z] 使板面成为 4mm 竖直细条（实测包围盒 z 向厚度为 0）。改为平置板：
   rotation [-1.5708,0,0]、scale [0.16,0.22,0.004]，落在充电托盘顶面。
2) door-panel-{fl,rl}-crystal：实测包围盒显示左门水晶件跑到门外侧（x≈0.982），
   左右符号写反——左门内面朝 -x，应为 -0.0423；右门 +0.0423 不变。
3) seat-third-row-headrest：与靠背顶端有 22mm 悬浮间隙，y 1.23 → 1.205。
4) rim-{fl,fr,rl,rr}：轮圈面（x=±0.993）被轮胎圆柱端面（x=±1.003）埋没 10mm，
   集成层 wheel-alloy 的盘面 Canvas 贴图（createWheelFaceTexture 20 开窗）因此不可见；
   轮圈宽度 0.235 → 0.27（面 x=±1.010，凸出胎面 7mm，呈浅盘状），零新增面数。
"""
import json
import os
import sys

SPEC_PATH = os.path.join(os.path.dirname(__file__), "..", "object-sculpt-spec.json")


def main():
    with open(SPEC_PATH, encoding="utf-8") as f:
        spec = json.load(f)
    comps = {c["id"]: c for c in spec["componentTree"]}

    # 1) 充电板平置
    for cid in ("charge-pad", "charge-pad-r"):
        c = comps[cid]
        c["transform"]["rotation"] = [-1.5708, 0, 0]
        c["transform"]["scale"] = [0.16, 0.22, 0.004]
        c["transform"]["position"][1] = 0.7965
        c["dimensions"] = {"width": 0.16, "height": 0.22, "depth": 0.004,
                           "units": "meters", "confidence": 0.9}
        lf = c.get("localFeatures") or []
        note = ("平置 plane-card：法线朝上，落在镀铬托盘（console-island-charge-tray 顶面 0.794）之上；"
                "plane-card 的板面为 x×y 面，旋转 [-1.5708,0,0] 后 y 向映射为进深。")
        if lf:
            lf[0]["note"] = lf[0].get("note", "") + " " + note
        c["surfaceDetail"]["notes"] = note

    # 2) 门板水晶左右符号
    for d, sgn in (("fl", -1), ("rl", -1), ("fr", 1), ("rr", 1)):
        c = comps[f"door-panel-{d}-crystal"]
        c["transform"]["position"][0] = 0.0423 * sgn
        lf = c.get("localFeatures") or []
        if lf:
            lf[0]["note"] = lf[0].get("note", "") + " 内面法向修正：左门 -x / 右门 +x（实测包围盒核验）。"

    # 3) 第三排头枕贴靠背
    c = comps["seat-third-row-headrest"]
    c["transform"]["position"][1] = 1.205

    # 4) 轮圈面露出（宽度 0.235 -> 0.27）
    for w in ("fl", "fr", "rl", "rr"):
        c = comps[f"rim-{w}"]
        c["transform"]["scale"][1] = 0.27
        c["dimensions"]["height"] = 0.27
        lf = c.get("localFeatures") or []
        feat = {"name": "浅盘轮圈面露出", "kind": "wheel-face",
                "note": ("轮圈宽度 0.235→0.27：盘面（world x≈±1.010）凸出轮胎端面（±1.003）7mm，"
                         "集成层 wheel-alloy 盘面 Canvas 贴图（createWheelFaceTexture：盘缘 20 开窗+曜日盾标）"
                         "由此可见；参考图 D1/D3/D4_轮毂-特写。")}
        if not lf:
            c["localFeatures"] = [feat]
        else:
            lf.append(feat)
        refs = c.get("evidenceRefs") or []
        if "img-wheel-turbine" not in refs:
            refs.append("img-wheel-turbine")

    with open(SPEC_PATH, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("geometry fixes applied; OK")


if __name__ == "__main__":
    sys.exit(main())
