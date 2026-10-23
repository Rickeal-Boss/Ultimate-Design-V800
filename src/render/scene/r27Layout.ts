/**
 * ⚠ 转发壳（R28 起）——布局真源已迁至 `r28Layout.ts`，本文件**不再持有任何常量**。
 *
 * 历史：R27 波次曾在此落布局真源；R28 环境全面重建（主殿/塔群/撞击换皮/崖体整删）
 * 后常量整体迁移并按 FBX 精测（`.qa/r28_fbx_measure.md`）+ 视觉双析
 * （`.qa/r28_vision.md`）+ 审计裁决（`.qa/r28_audit.md`）修订。
 *
 * 保留 `export *` 转发是为兼容既有 import（castleKit/Road/Terrain 等）；
 * **新代码一律直接 `import ... from './r28Layout'`**。任何常量诉求提给主理人
 * 在 r28Layout 落笔，禁止在本文件或实现线各自重定义。
 */
export * from './r28Layout';
