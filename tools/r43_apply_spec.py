# -*- coding: utf-8 -*-
"""R43-P0A 车模外观 spec 改稿器（唯一写入口；写盘铁律见下）

写盘铁律（本机实证，勿改）：
  · json.dump(indent=1) —— indent=2 会制造 9 万行 diff 噪声
  · V800 spec：LF + **无末尾换行**，round-trip 必须 byte-identical（本脚本每次先自检）
  · R7 spec  ：LF + **有末尾换行**
  · 所有改动都带断言（组件 id 命中必须恰好 1 个 / 原值必须等于预期旧值），
    任何一条不满足就整体 abort，不写盘 —— 防「对着空气改红线条」。

用法:
  python tools/r43_apply_spec.py v800 --dry      # 只打印改动，不写
  python tools/r43_apply_spec.py v800            # 应用并写盘
"""
import io
import json
import sys

SPEC = {
    "v800": ".img2threejs/object-sculpt-spec.json",
    "r7": ".img2threejs/r7-sculpt-spec.json",
}
TRAILING_NL = {"v800": False, "r7": True}

# ── 批次1：轮位归位 + 车身收顶到腰线 + 温室/立柱/车顶 + 端面收边 ─────────────
# 依据（.qa/r43_car/measure_v800.json 精测）：
#   · 轮位：body-lower 的轮拱开口中心 z=+1.7334/-1.6967、wheel-cap-* 在 ±1.715
#     ⇒ 设计轴位 = ±1.715（轴距 3.43 = 申报值）；而 wheel-f* 在 1.333、wheel-r* 在 -2.097
#     ⇒ 四个轮组整体错位 +0.382。前悬 1.332（申报 0.940）/后悬 0.739（申报 1.125）是错值。
#   · 腰线：FBX 实测 DLO 下沿 y≈1.190（12 个站位里 9 个恒为 1189.5），车顶 1830~1850
#     ⇒ DLO 高度 660；而 body-lower 顶部原在 y=1.66（把 0.1..1.66 的窗全埋进壳体，
#     只剩 1.66..1.76 一条 10cm 缝隙可见）⇒ 车身侧皮顶边收到腰线。
#   · 俯视：实测半宽在车头最后 0.2m 才从 0.96→0.74，车尾同理 ⇒ 端面 planTaper 加强。
BELT = [  # (z, y)：车身侧皮顶边 = 腰线；y 随 z 向后微升（实测 DLO 下沿 1.10→1.19）
    [1.85, 1.062], [1.60, 1.098], [1.20, 1.118], [0.60, 1.140],
    [0.00, 1.152], [-0.90, 1.170], [-1.60, 1.182], [-1.8029, 1.188],
]
REAR_LIFT = 0.150   # 尾部顶边整体抬到与腰线连续（原 1.035 → 1.185）

EDITS = []


def edit(cid, path, old, new, why):
    EDITS.append({"id": cid, "path": path, "old": old, "new": new, "why": why})


# 1) 轮组：**不动**。
#    ⚠ 2026-11-01 实测推翻「轮位错位」假设（第一版改稿曾把 wheel-* 的 z 从
#    1.333/-2.097 移到 1.715/-1.715，截图后发现轮子跑到保险杠里 ⇒ 已回滚）。
#    原因：`wheel-f*` 是**容器**，子件 tire/rim 自身带 z=+0.382/0.394 偏移
#      ⇒ 实际胎心 z = 1.333 + 0.382 = **1.715**，与 wheel-cap-* 的 ±1.715、
#        申报轴距 3430、前悬 940/后悬 1125 完全一致。
#    body-lower 的轮拱开口中心 1.7334/-1.6967 相对胎心只差 18/18mm（肉眼不可辨），
#    属历史小偏置，本轮不动（动它要重排 12 个轮廓点，收益 <3mm 风险不值）。

# 2) body-lower 侧皮顶边：A 柱/车顶/D 柱弧 → 腰线折线
edit("body-lower", ["geometryDescriptor", "profile2D", "points"], "@SLICE@", BELT,
     "车顶弧段（idx30..43）替换为腰线折线：暴露被壳体吞掉的 DLO（原顶部 1.66 高于窗带底 1.10）")

# 3) body-lower 端面 planTaper 加强（消除 2m 宽平头/平尾）
edit("body-lower", ["geometryDescriptor", "profile2D", "shaping", "planTaperNose"],
     {"zFrom": 1.35, "zTo": 2.658, "amount": 0.035, "yGate": 1.12, "yFade": 0.12},
     {"zFrom": 2.10, "zTo": 2.68, "amount": 0.245},
     "车头俯视收边：实测最后 0.2m 半宽 0.96→0.74；原 3.5% 几乎不收 → 平头盒感")
edit("body-lower", ["geometryDescriptor", "profile2D", "shaping", "planTaperTail"],
     {"zFrom": -2.7, "zTo": -2.822, "amount": 0.02, "yGate": 1.12, "yFade": 0.12},
     {"zFrom": -2.42, "zTo": -2.83, "amount": 0.225},
     "车尾俯视收边：实测 -2.42→-2.77 半宽 0.926→0.773；原 2% 只做 12cm 圆角")

# 4) greenhouse-glass：窗带内收 + 温室 tumblehome（实测腰带 1010 → 窗上沿 810~870）
edit("greenhouse-glass", ["geometryDescriptor", "profile2D", "depth"], 1.924, 1.87,
     "窗带半宽 0.962→0.935：给立柱留出外露余量（立柱/窗框须在玻璃外侧才可见）")
edit("greenhouse-glass", ["geometryDescriptor", "profile2D", "shaping", "tumblehome"],
     {"yBase": 1.101, "yTop": 1.761, "topScale": 0.985},
     {"yBase": 1.15, "yTop": 1.74, "topScale": 0.925},
     "温室上部内倾：实测窗上沿半宽约 0.81~0.87（原 0.985 等于垂直侧窗 = 玻璃盒子感）")

# 5) 立柱外置到玻璃外侧（原 x=±0.905 在玻璃 0.962 之内 ⇒ 完全被吞，DLO 无分缝）
for cid in ("bpillar-l", "bpillar-r", "cpillar-l", "cpillar-r"):
    edit(cid, ["transform", "position", 0], 0.905 if cid.endswith("-l") else -0.905,
         0.945 if cid.endswith("-l") else -0.945,
         "B/C 柱移到玻璃(0.935)外侧 10mm：DLO 才有窗框分缝")
    edit(cid, ["transform", "position", 1], 1.3575, 1.455,
         "立柱高度对齐新 DLO（腰带 1.15 → 窗上沿 1.74）")
    edit(cid, ["transform", "scale", 1], 0.675, 0.60, "立柱高 0.675→0.60 匹配新 DLO 高度")
for cid in ("dpillar-l", "dpillar-r"):
    edit(cid, ["transform", "position", 0], 0.885 if cid.endswith("-l") else -0.885,
         0.925 if cid.endswith("-l") else -0.925,
         "D 柱外置到玻璃外侧（原 0.885+0.065=0.950 只露 15mm）")

# 6) roof-panel 收窄：车顶须比玻璃上沿略宽（形成檐口），原 1.86 比窗上沿宽太多 = 平台感
edit("roof-panel", ["geometryDescriptor", "profile2D", "depth"], 1.86, 1.78,
     "车顶半宽 0.93→0.89：与窗上沿 0.865 形成 25mm 檐口（原车顶比窗宽 65mm = 大平板）")

# ── 批次2（首轮目检后追加）────────────────────────────────────────────────
# 7) 风挡 / A 柱归位：原中心 y=1.82/1.80 沿 55° 长 0.83~0.86 的板 ⇒ 顶端 y≈2.14，
#    比车顶 1.85 高出 0.3m，在侧视/3-4 视里是一块"浮在车顶上方的黑楔"。实测车顶前缘
#    z≈1.14/y≈1.80 与风挡下沿（cowl-panel y1.105/z1.54）定出正确中心 (1.445,1.38)。
edit("windshield", ["transform", "position", 1], 1.8195, 1.445,
     "风挡下移到 cowl(1.105)→车顶前缘(1.80) 的连线中点，消除顶端高出车顶 0.3m 的黑楔")
edit("windshield", ["transform", "position", 2], 1.127, 1.38,
     "风挡前移至 cowl z=1.54 → 车顶 z=1.14 的中点（原 1.127 与 A 柱同位＝错位）")
edit("windshield", ["transform", "rotation", 0], 0.9599, 1.004, "风挡倾角微调至与 A 柱同斜率")
for cid, sx in (("apillar-l", 0.93), ("apillar-r", -0.93)):
    edit(cid, ["transform", "position", 1], 1.8, 1.45, "A 柱同上归位（原顶端 y=2.14 穿出车顶）")
    edit(cid, ["transform", "position", 2], 1.14, 1.34, "A 柱 z 归位到 cowl→车顶前缘连线")
    edit(cid, ["transform", "rotation", 0], 0.953, 1.004, "A 柱倾角与风挡同源")

# 8) 前脸文字件缩小：用户明确「文字部分精度不高看起来乱码、文字一律不复刻」。
#    原 0.8m 宽 × 0.06 高的 plane-card 文字贴在黑格栅上 = 全车最显眼的"大字报"。
edit("maextro-mark", ["transform", "scale", 0], 0.8, 0.30, "字标缩到 0.30m（原 0.8m 大字报）")
edit("maextro-mark", ["transform", "scale", 1], 0.06, 0.026, "字标高度同步压缩")

# 9) 前脸横贯件收窄 —— **本轮不做**（诚实标注）：
#    body-lower 车头 planTaper 提到 24.5% 后，`chrome-brow`(1.84) / `bumper-lower`(1.92) /
#    `bumper-chrome-lip`(1.86) 这几条横贯件的世界半宽约 0.98~0.99，比收边后的车体
#    （z≈2.3 处 0.93）宽 60~70mm ⇒ 3/4 机位上是四片"银色翅膀"。
#    为什么不动：这些件挂在 front-end(scale.x=1.062) 与 bumper-lower(scale.x=1.92)
#    两级父链下，profile 点列并非归一化单位，**无法从 spec 直接算出世界宽度**
#    （试算结果差 2 倍以上）。盲改会造出「保险杠缩进车体内」的新缺陷，比现在更糟。
#    ⇒ 记为遗留项：需要先用 adapter 的世界 bbox 探针量出真实半宽，再按比例收。


# ── R7（智界 R7）：结构与 V800 不同 —— 它的 body-lower 顶边**本来就是腰线**
#    （profile top y≈1.089~1.093，56 点），没有 V800 那种「壳体吞掉 DLO」病；
#    玻璃带叫 windshield（侧面挤出 depth 1.78），B/C 柱已外置于 0.922。
#    实测（.qa/r43_car/measure_r7.json，白模.fbx）唯一同病：**端面俯视几乎不收边**
#    —— 车头最后 0.3m 半宽 0.925→0.60、车尾 0.90→0.60，而 spec 里只有 3%/3%。
#    ⇒ 本轮 R7 只做这一处（形体失真最大项），不碰温室/立柱（无实测支撑改动收益）。
R7_EDITS = []


def r7_edit(cid, path, old, new, why):
    R7_EDITS.append({"id": cid, "path": path, "old": old, "new": new, "why": why})


r7_edit("body-lower", ["geometryDescriptor", "profile2D", "shaping", "planTaperNose"],
        {"zFrom": 1.6, "zTo": 2.41, "amount": 0.03, "yGate": 1.12},
        {"zFrom": 2.10, "zTo": 2.412, "amount": 0.235},
        "R7 车头俯视收边：实测最后 0.3m 0.925→0.60；原 3% ⇒ 平头")
r7_edit("body-lower", ["geometryDescriptor", "profile2D", "shaping", "planTaperTail"],
        {"zFrom": -1.8, "zTo": -2.42, "amount": 0.03, "yGate": 1.12},
        {"zFrom": -2.12, "zTo": -2.42, "amount": 0.215},
        "R7 车尾俯视收边：实测 0.90→0.60；原 3% ⇒ 平尾")

def apply(data, edits, dry=False):
    tree = data["componentTree"]
    by_id = {}
    for c in tree:
        by_id.setdefault(c["id"], []).append(c)
    log = []
    for e in edits:
        hit = by_id.get(e["id"], [])
        assert len(hit) == 1, "组件 %s 命中 %d 个（期望 1）" % (e["id"], len(hit))
        node = hit[0]
        cur = node
        for k in e["path"][:-1]:
            if isinstance(k, int):
                assert isinstance(cur, list) and len(cur) > k, "%s 路径越界 %r" % (e["id"], e["path"])
                cur = cur[k]
            else:
                assert isinstance(cur, dict) and k in cur, "%s 缺键 %s" % (e["id"], k)
                cur = cur[k]
        last = e["path"][-1]
        if e["old"] == "@SLICE@":
            assert isinstance(cur, dict) and len(cur["points"]) == 85, "body-lower 点数不是 85"
            pts = cur["points"]
            assert pts[29] == [2.2479, 1.0301] and pts[30] == [1.05, 1.09], "腰线切片锚点不符"
            assert pts[43] == [-1.8029, 1.0898], "腰线切片尾锚点不符"
            new_pts = pts[:30] + e["new"] + pts[44:]
            # 尾部顶边整体抬起（idx45..49 相对旧 30 号位之后偏移）
            i45 = 30 + len(e["new"]) + 1
            for k in range(i45, i45 + 5):
                assert new_pts[k][1] < 1.10, "尾部顶边锚点异常 %r" % (new_pts[k],)
                new_pts[k] = [new_pts[k][0], round(new_pts[k][1] + REAR_LIFT, 4)]
            log.append("body-lower.points 85 → %d（腰线折线 %d 点；尾部顶边 +%.3f）"
                       % (len(new_pts), len(e["new"]), REAR_LIFT))
            cur["points"] = new_pts
            continue
        old_actual = cur[last]
        assert old_actual == e["old"], "%s.%s 原值不符：期望 %r 实际 %r" % (
            e["id"], ".".join(str(x) for x in e["path"]), e["old"], old_actual)
        cur[last] = e["new"]
        log.append("%s.%s: %r → %r" % (e["id"], ".".join(str(x) for x in e["path"]),
                                       old_actual, e["new"]))
    return log


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "v800"
    dry = "--dry" in sys.argv
    path = SPEC[which]
    raw = open(path, "rb").read()
    data = json.loads(raw.decode("utf-8"))

    # round-trip 自检（写盘前先证明"不改内容就 byte-identical"）
    buf = io.StringIO()
    json.dump(data, buf, indent=1, ensure_ascii=False)
    out0 = buf.getvalue() + ("\n" if TRAILING_NL[which] else "")
    assert out0.encode("utf-8") == raw, "round-trip 非 byte-identical —— 写盘纪律不成立，abort"

    log = apply(data, EDITS if which == "v800" else R7_EDITS, dry)
    print("== %s：%d 处改动" % (path, len(log)))
    for line in log:
        print("  ·", line)
    if dry:
        print("（--dry：未写盘）")
        return 0
    buf = io.StringIO()
    json.dump(data, buf, indent=1, ensure_ascii=False)
    out = (buf.getvalue() + ("\n" if TRAILING_NL[which] else "")).encode("utf-8")
    open(path, "wb").write(out)
    print("写盘 %s  %d bytes → %d bytes" % (path, len(raw), len(out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
