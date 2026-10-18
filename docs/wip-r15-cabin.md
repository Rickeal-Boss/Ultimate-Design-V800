# WIP R15 座舱遮挡诊断（v800-landing-review，只诊断不改码）

## 写盘竞态排查（2026-10-19 00:42）
- spec mtime=10-18 23:36:45，src 最新 mtime=10-18 18:23，当前 00:42 —— 无在途写盘，**竞态已排除**。

## 眼点射线（preview #assembled，EYE=-0.55,1.33,-0.58 → 路面点(-0.42,0.03,-30.58)）
- 前 3 命中全部是**玻璃**：`windshield|glass-clear @0.903 (hitY=1.291, z=-1.482)` →
  `greenhouse-glass|glass-dark @0.919` → `windshield|glass-clear @0.934`。
- 即：视线到路面要先穿过风挡；风挡被穿过的位置 (y=1.291) 只比三联屏顶沿 (1.2875) 高 3.5mm。
- 游戏内 cabin 模式 Game 隐藏 glass-clear，但 **greenhouse-glass(glass-dark) 未隐藏**——待验证。

## pitch 扇扫描（含玻璃，方位朝车头）
- +12°~ -3°：windshield|glass-clear（透过风挡看远处）
- -4°~ -11°：tri-screen|screen-ui @0.83m（hitY 1.272 → …）
- -12°：steering|wood @0.82m（方向盘轮缘，hitY=1.16）
- -15°：tri-screen @0.87（hitY=1.104）
- -16°及以下：greenhouse-glass|glass-dark @0.82m（hitY≈1.103 起持续命中）→ 待解释，
  需 boxes/meshes 拿 greenhouse-glass 的世界 bbox。

## 俯角表（EYE y=1.33）
- tri-screen 顶沿 1.2875@z-1.42 → 俯角 2.9°；底沿 0.9725 → 23.05°
- dash-upper 顶面 0.985：前缘 z-1.32 → 25°，后缘 z-1.78 → 16.04°
- dash-lower 底 0.67@z-1.45 → 37.18°
- 注视点俯角 1.76°；cabin FOV=68 → 半垂直 34°，画面底沿俯角 = 1.76+34 = 35.76°，
  画面顶沿 = 1.76-34 = -32.2°（即抬头 32°）。
