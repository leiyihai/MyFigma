// Purpose classification for imported main components. Rules are deliberately
// deterministic: nine-slice usage, then original-name keywords, then a coarse
// size ratio. Anything uncertain stays 未分类; no image recognition is involved.
export const categories = ['按钮','底板','图标','背景','艺术字','进度条','未分类'] as const;
export type CategoryName = (typeof categories)[number];

export type CategoryInput = { frameName: string; width: number; height: number };

const nameRules: ReadonlyArray<{category: CategoryName; keywords: readonly string[]}> = [
  {category:'按钮', keywords:['按钮','btn','button']},
  {category:'进度条', keywords:['进度','progress','pbar','progressbar','loading']},
  {category:'底板', keywords:['底板','面板','panel']},
  {category:'图标', keywords:['图标','icon']},
  {category:'背景', keywords:['背景','bg','background']},
  {category:'艺术字', keywords:['艺术字','wordart','artfont','font','title']}
];

export function categoryIndex(category: CategoryName): number {
  return categories.indexOf(category);
}

export function isCategoryName(value: unknown): value is CategoryName {
  return typeof value === 'string' && (categories as readonly string[]).includes(value);
}

export function classify(input: CategoryInput): CategoryName {
  const name = input.frameName.toLocaleLowerCase();
  for(const rule of nameRules) if(rule.keywords.some(keyword => name.includes(keyword))) return rule.category;
  const width = input.width, height = input.height;
  if(!(width > 0 && height > 0)) return '未分类';
  if(width >= 512 && height >= 512) return '背景';
  const small = Math.min(width,height), large = Math.max(width,height);
  if(small >= 8 && large <= 256 && large / small <= 1.5) return '图标';
  if(height >= 8 && height <= 96 && width >= height * 2.5 && width <= 1024) return '按钮';
  return '未分类';
}

// Display name format: 分类/散图原名. `sourceInfo` is the source location and
// is only appended when two components in the same category share a name.
export function componentName(category: CategoryName, frameName: string, sourceInfo?: string): string {
  return sourceInfo ? `${category}/${frameName} · ${sourceInfo}` : `${category}/${frameName}`;
}
