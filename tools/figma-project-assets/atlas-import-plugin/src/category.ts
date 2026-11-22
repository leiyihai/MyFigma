// Purpose classification and page-level category configuration for imported
// main components. Classification rules are deliberately deterministic and
// ordered: a leading token of the original sprite name, then full-name
// keywords, then a coarse size ratio. Nine-slice usage, margins and slice
// structure only decide the stretch behaviour and never the purpose. Anything
// uncertain stays 未分类; no image recognition is involved.
export interface Category { name: string; color: string }
export interface CategoryConfig { schemaVersion: 1; categories: Category[] }

// Default seven with stable colours. Stored page configurations may add,
// reorder or drop entries, but 未分类 always exists as the fallback bucket.
export const defaultCategories = [
  {name:'按钮', color:'#e5484d'},
  {name:'底板', color:'#8e4ec6'},
  {name:'图标', color:'#f2a900'},
  {name:'背景', color:'#3e63dd'},
  {name:'艺术字', color:'#d6409f'},
  {name:'进度条', color:'#30a46c'},
  {name:'未分类', color:'#8b8d98'}
] as const satisfies readonly Category[];
export const unsortedCategory = '未分类';

// Fixed palette for categories added later: append-only so a stored assignment
// stays meaningful, with the default seven occupying the first slots.
export const categoryPalette: readonly string[] = [
  ...defaultCategories.map(category => category.color),
  '#0091ff','#12a594','#ab4aba','#e93d82','#6e56cf'
];

export const categoryConfigKey = 'atlas.categories.v1';
export const categoryNameLimit = 24;

// A prefix only counts as the leading token: letters up to the first digit,
// separator or other script, so `btn2_ok`, `BTN_OK` and `btn-ok` all read
// `btn`, while `bgm_panel` does not pretend to be `bg`.
const prefixRules: ReadonlyArray<{category: string; prefixes: readonly string[]}> = [
  {category:'按钮', prefixes:['btn','button']},
  {category:'图标', prefixes:['icon']},
  {category:'背景', prefixes:['bg','background']},
  {category:'底板', prefixes:['panel']},
  {category:'进度条', prefixes:['progress','pbar']},
  {category:'艺术字', prefixes:['font','wordart']}
];

const nameRules: ReadonlyArray<{category: string; keywords: readonly string[]}> = [
  {category:'按钮', keywords:['按钮','btn','button']},
  {category:'进度条', keywords:['进度','progress','pbar','progressbar','loading']},
  {category:'底板', keywords:['底板','面板','panel']},
  {category:'图标', keywords:['图标','icon']},
  {category:'背景', keywords:['背景','bg','background']},
  {category:'艺术字', keywords:['艺术字','wordart','artfont','font','title']}
];

export type CategoryInput = { frameName: string; width: number; height: number };

export function classify(input: CategoryInput): string {
  const name = input.frameName.toLocaleLowerCase();
  const token = name.match(/^[a-z]+/)?.[0];
  if(token) for(const rule of prefixRules) if(rule.prefixes.includes(token)) return rule.category;
  for(const rule of nameRules) if(rule.keywords.some(keyword => name.includes(keyword))) return rule.category;
  const width = input.width, height = input.height;
  if(!(width > 0 && height > 0)) return unsortedCategory;
  if(width >= 512 && height >= 512) return '背景';
  const small = Math.min(width,height), large = Math.max(width,height);
  if(small >= 8 && large <= 256 && large / small <= 1.5) return '图标';
  if(height >= 8 && height <= 96 && width >= height * 2.5 && width <= 1024) return '按钮';
  return unsortedCategory;
}

// Display name format: 分类/散图原名. `sourceInfo` is the source location and
// is only appended when two components in the same category share a name.
export function componentName(category: string, frameName: string, sourceInfo?: string): string {
  return sourceInfo ? `${category}/${frameName} · ${sourceInfo}` : `${category}/${frameName}`;
}

// Category names become Frame names and display-name prefixes, so keep them
// plain: no path separators or control characters, bounded length, trimmed.
export function categoryNameProblem(value: unknown): string | undefined {
  if(typeof value !== 'string') return '类别名称必须是文本';
  const name = value.trim();
  if(!name) return '类别名称不能为空';
  if(name.length > categoryNameLimit) return `类别名称最多 ${categoryNameLimit} 个字符`;
  if(/[\\/\x00-\x1f\x7f]/.test(name)) return '类别名称不能包含 / \\ 或控制字符';
  return undefined;
}

export function categoryColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
}

// Missing data means the default seven. Unreadable data still yields the
// default seven but reports `repaired` so the caller can write the repair back
// instead of blocking the import or the page validation.
export function readCategoryConfig(raw: string | undefined | null): {config: CategoryConfig; repaired: boolean} {
  if(!raw) return {config:defaultConfig(), repaired:false};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {config:defaultConfig(), repaired:true}; }
  const record = value as Partial<CategoryConfig> | null;
  const list = record && typeof record === 'object' ? record.categories : undefined;
  if(!record || record.schemaVersion !== 1 || !Array.isArray(list) || !list.length || list.length > 64) {
    return {config:defaultConfig(), repaired:true};
  }
  const parsed: Category[] = [];
  let repaired = false;
  for(const entry of list) {
    const candidate = entry && typeof entry === 'object' ? entry as Partial<Category> : {};
    const color = categoryColor(candidate.color);
    if(categoryNameProblem(candidate.name) || !color) return {config:defaultConfig(), repaired:true};
    const name = (candidate.name as string).trim();
    if(name !== candidate.name) repaired = true;
    if(parsed.some(existing => existing.name === name)) return {config:defaultConfig(), repaired:true};
    parsed.push({name, color});
  }
  if(!parsed.some(category => category.name === unsortedCategory)) {
    parsed.push({...defaultCategories[defaultCategories.length - 1]});
    repaired = true;
  }
  return {config:{schemaVersion:1,categories:parsed}, repaired};
}

export function serializeCategories(config: CategoryConfig): string {
  return JSON.stringify({schemaVersion:1,
    categories:config.categories.map(category => ({name:category.name, color:category.color}))});
}

function defaultConfig(): CategoryConfig {
  return {schemaVersion:1, categories:defaultCategories.map(category => ({...category}))};
}

export function knownCategory(config: CategoryConfig, value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 &&
    config.categories.some(category => category.name === value) ? value : undefined;
}

// Unknown names sort after every configured category instead of jumping to the
// front the way `indexOf`'s -1 would; ordering is a page-configuration decision.
export function categoryIndex(names: readonly string[], name: string): number {
  const index = names.indexOf(name);
  return index < 0 ? names.length : index;
}

// Classification only knows the six rule categories, so a name that the page
// configuration dropped falls back to 未分类 instead of creating an unmanaged Frame.
export function categoryOr(config: CategoryConfig, name: string): string {
  if(knownCategory(config, name)) return name;
  const fallback = config.categories.find(category => category.name === unsortedCategory);
  return fallback ? fallback.name : config.categories[0].name;
}
