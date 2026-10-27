/* ================= [IRON] 烫法与按板规格的参数表 =================
 * 平面烫豆预览可切换的烫法；参数不给玩家调，按板规格各定一套，让纹理看得出、又不压过图案。
 * 每套参数：melt = 进度 100% 时的熔化度（1 = 烫透成方块）；amp = 纹理强度；scale = 纹理尺度（以格为单位，>1 纹理更粗）；
 * p = 该烫法专属参数（0..1）；sh = 着色器里的烫法编号。
 * 豆子物理尺寸固定、烫布纹理也固定，本该与格数无关；但大板在屏幕上每格只有几个像素，细纹理会糊成噪点，
 * 所以大板把纹理放粗、减弱。数值在历史案例上回归调定后写在这里。
 * 自定义尺寸按边长取最近的一档。 */
const IRON_STYLES = [
  { key: 'plain', name: '无孔', sh: 0, mat: [.56, .48, .12, 22] },
  { key: 'towel', name: '毛巾', sh: 2, mat: [.60, .44, .03, 8] },
  { key: 'bath', name: '澡巾', sh: 1, mat: [.56, .48, .07, 12] },
  // 细闪 / 粗闪共用闪粒着色（sh 3），差别在 glit：[闪粒位边长（格）, 有闪粒比例, 不对光时的提亮程度, 闪光锐度（越小每颗闪片对上光的角度越宽、同时亮起的越多）]；p[0] 是彩色闪片占比（细闪、粗闪都为 0，只出白光）
  { key: 'fine', name: '细闪', sh: 3, mat: [.56, .46, .10, 26], glit: [.16, .45, .15, 140] },
  { key: 'coarse', name: '粗闪', sh: 3, mat: [.56, .46, .14, 18], glit: [.52, .55, .45, 70], glitFill: true },
];
const IRON_DEFAULT_STYLE = 'plain';
const IRON_PARAMS = {
  36: { plain: { melt: 1, amp: 1, scale: 1, p: [] }, towel: { melt: 1, amp: 1, scale: 1, p: [0, .5, .5] }, bath: { melt: 1, amp: 1, scale: 1, p: [.5] }, fine: { melt: 1, amp: 1, scale: 1, p: [0] }, coarse: { melt: 1, amp: 1, scale: 1, p: [0] } },
  52: { plain: { melt: 1, amp: 1, scale: 1, p: [] }, towel: { melt: 1, amp: 1, scale: 1, p: [0, .5, .5] }, bath: { melt: 1, amp: 1, scale: 1, p: [.5] }, fine: { melt: 1, amp: 1, scale: 1, p: [0] }, coarse: { melt: 1, amp: 1, scale: 1, p: [0] } },
  78: { plain: { melt: 1, amp: 1, scale: 1, p: [] }, towel: { melt: 1, amp: 0.9, scale: 1.1, p: [0, .5, .5] }, bath: { melt: 1, amp: 0.9, scale: 1.1, p: [.5] }, fine: { melt: 1, amp: 0.9, scale: 1.1, p: [0] }, coarse: { melt: 1, amp: 0.9, scale: 1.1, p: [0] } },
  104: { plain: { melt: 1, amp: 1, scale: 1, p: [] }, towel: { melt: 1, amp: 0.8, scale: 1.3, p: [0, .5, .5] }, bath: { melt: 1, amp: 0.8, scale: 1.3, p: [.5] }, fine: { melt: 1, amp: 0.8, scale: 1.3, p: [0] }, coarse: { melt: 1, amp: 0.8, scale: 1.3, p: [0] } },
  156: { plain: { melt: 1, amp: 1, scale: 1, p: [] }, towel: { melt: 1, amp: 0.6, scale: 1.7, p: [0, .5, .5] }, bath: { melt: 1, amp: 0.6, scale: 1.7, p: [.5] }, fine: { melt: 1, amp: 0.6, scale: 1.7, p: [0] }, coarse: { melt: 1, amp: 0.6, scale: 1.7, p: [0] } },
};
/* 烫法 → 闪粒参数（无闪粒的烫法返回占位值，着色器不读），平面、3D 与导出海报共用。
 * glitFill：大板的纹理强度 amp 按规格调低（见 IRON_PARAMS），闪光也跟着变暗、能看见的亮点变少；
 * 有闪粒比例按 1/amp 放大补回，任何规格（含自定义尺寸）同时亮起的闪点数量都与小板相当 */
function ironGlitterFor(side, key) {
  const s = IRON_STYLES.find(x => x.key === key);
  if (!s || !s.glit) return [.3, 0, 0, 140];
  const g = s.glit.slice();
  if (s.glitFill) g[1] = Math.min(.95, g[1] / Math.max(ironParamsFor(side, key).amp || 1, .3));
  return g;
}
/* 板边长（格数）→ 该烫法的参数 */
function ironParamsFor(side, key) {
  const tiers = Object.keys(IRON_PARAMS).map(Number);
  const t = tiers.reduce((a, b) => Math.abs(b - side) < Math.abs(a - side) ? b : a, tiers[0]);
  return IRON_PARAMS[t][key];
}
