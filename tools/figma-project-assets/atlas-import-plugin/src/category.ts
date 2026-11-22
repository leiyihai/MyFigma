// Purpose classification and page-level category configuration for imported
// main components. Classification rules are deliberately deterministic and
// ordered: a leading token of the original sprite name, then full-name
// keywords, then a coarse size ratio. Nine-slice usage, margins and slice
// structure only decide the stretch behaviour and never the purpose. Anything
// uncertain stays 未分类; no image recognition is involved.
// 类别名是页面配置里的字符串标识；集中成别名，避免各处把它和显示名、身份混用。
export type CategoryName = string;
export interface Category { name: CategoryName; color: string }
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

// Colour assignment for a category added later: the first unused palette entry.
// Stored configurations keep their colours, so reopening a page recomputes the
// same answer and a second addition never recolours the first. Once the palette
// is exhausted the old colour is never reused: colours are generated along the
// hue wheel by index, which keeps a given index stable and skips colours already
// in use so new categories stay distinguishable from existing ones.
function hslColor(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  const [red, green, blue] = hue < 60 ? [chroma, second, 0] : hue < 120 ? [second, chroma, 0]
    : hue < 180 ? [0, chroma, second] : hue < 240 ? [0, second, chroma]
    : hue < 300 ? [second, 0, chroma] : [chroma, 0, second];
  const hex = (value: number) => Math.round((value + offset) * 255).toString(16).padStart(2, '0');
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}
function generatedCategoryColor(index: number): string {
  // 黄金角步长让相邻索引的色相尽量分开，而不是沿色环缓慢移动。
  return hslColor((index * 137.508) % 360, 0.62, 0.52);
}
export function nextCategoryColor(categories: readonly Category[]): string {
  const used = new Set(categories.map(category => category.color));
  const unused = categoryPalette.find(color => !used.has(color));
  if(unused) return unused;
  for(let index = 0; ; index++) {
    const color = generatedCategoryColor(index);
    if(!used.has(color)) return color;
  }
}

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

// 名称族规律（#21）：从当前页的人工标签学出「名称 token → 类别」。
// token 化与匹配共用一套实现，避免学习和应用对名称的理解漂移。
// 页面只有一个键，值有序（support 降序、同 support 按 token 升序），可回读。
export const categoryRulesKey = 'atlas.category.rules.v1';
export const categoryRuleLimit = 400;
const categoryRuleMinSupport = 2;
const categoryRuleMinPurity = 0.6;
export type CategoryRuleKind = 'prefix' | 'suffix' | 'glyph';
export interface CategoryRule {
  kind: CategoryRuleKind; token: string; category: CategoryName;
  support: number; purity: number; conflicts: number;
}
export interface CategoryRules { schemaVersion: 1; rules: CategoryRule[] }
export type CategoryToken = { kind: CategoryRuleKind; token: string };
// 按 kind+token 预先分桶，名称匹配只查自己的 token，避免逐条扫全表。
export type CategoryRuleIndex = ReadonlyMap<string, readonly CategoryRule[]>;
export interface ClassifiedCategory { category: CategoryName; learned: boolean }

const tokenKey = (token: CategoryToken): string => token.kind + '\u0000' + token.token;

// 名称切词：小写后按非字母数字中文分隔；首段记前缀族，其余记后缀/词族。
// 纯数字名称与 `number_*` 归一为「字形」族；同一名称里重复的 token 只算一票。
export function categoryTokens(frameName: string): CategoryToken[] {
  const name = String(frameName ?? '').toLocaleLowerCase();
  const parts = name.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(part => part.length > 0);
  const tokens: CategoryToken[] = [];
  if(parts.length) {
    tokens.push({kind:'prefix', token:parts[0]});
    for(const part of parts.slice(1)) tokens.push({kind:'suffix', token:part});
  }
  if(/^[0-9]+$/.test(name) || parts[0] === 'number') tokens.push({kind:'glyph', token:'glyph'});
  const seen = new Set<string>();
  return tokens.filter(token => {
    const key = tokenKey(token);
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface CategorySample { frameName: string; category: CategoryName }

// 学习：每个 token 统计各类别票数，多数票即规则类别，冲突数照实记录。
// 只保留 support ≥ 2 且 purity ≥ 0.6 的族，容忍少量标注噪声而不是整体失效。
export function learnCategoryRules(samples: readonly CategorySample[]): CategoryRule[] {
  const counts = new Map<string, {kind: CategoryRuleKind; token: string; total: number; votes: Map<string, number>}>();
  for(const sample of samples) {
    if(!sample || typeof sample.frameName !== 'string' || typeof sample.category !== 'string' || !sample.category) continue;
    for(const token of categoryTokens(sample.frameName)) {
      const key = tokenKey(token);
      let entry = counts.get(key);
      if(!entry) { entry = {kind:token.kind, token:token.token, total:0, votes:new Map()}; counts.set(key, entry); }
      entry.total++;
      entry.votes.set(sample.category, (entry.votes.get(sample.category) || 0) + 1);
    }
  }
  const rules: CategoryRule[] = [];
  for(const entry of counts.values()) {
    if(entry.total < categoryRuleMinSupport) continue;
    // 同票时按类别名排序取最小，结果不依赖标签写入顺序。
    const ranked = [...entry.votes].sort((left,right) => right[1] - left[1] ||
      (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    const [category, best] = ranked[0];
    const purity = Math.round(best / entry.total * 1000) / 1000;
    if(purity < categoryRuleMinPurity) continue;
    rules.push({kind:entry.kind, token:entry.token, category, support:entry.total, purity, conflicts:entry.total - best});
  }
  rules.sort((left, right) => right.support - left.support || compareText(left.token, right.token) || compareText(left.kind, right.kind));
  return rules.slice(0, categoryRuleLimit);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ruleValue(entry: unknown): CategoryRule | undefined {
  if(!entry || typeof entry !== 'object') return undefined;
  const candidate = entry as Partial<CategoryRule>;
  const kind = candidate.kind;
  if(kind !== 'prefix' && kind !== 'suffix' && kind !== 'glyph') return undefined;
  if(!intValue(candidate.support) || candidate.support < 1 || !intValue(candidate.conflicts)) return undefined;
  if(typeof candidate.purity !== 'number' || !(candidate.purity > 0) || candidate.purity > 1) return undefined;
  if(typeof candidate.token !== 'string' || !candidate.token || candidate.token.length > 64) return undefined;
  if(kind === 'glyph' ? candidate.token !== 'glyph' : !/^[a-z0-9\u4e00-\u9fff]+$/.test(candidate.token)) return undefined;
  if(categoryNameProblem(candidate.category)) return undefined;
  return {kind, token:candidate.token, category:(candidate.category as string).trim(),
    support:candidate.support, purity:candidate.purity, conflicts:candidate.conflicts};
}

function intValue(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

// 缺失意味着还没有学习；损坏或含非法条目时整份回退空规则并报告 `repaired`，
// 让调用方回写重建，而不是阻断导入或页面校验（与类别配置同一风格）。
export function readCategoryRules(raw: string | undefined | null): {rules: CategoryRule[]; repaired: boolean} {
  if(!raw) return {rules:[], repaired:false};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {rules:[], repaired:true}; }
  const record = value as Partial<CategoryRules> | null;
  const list = record && typeof record === 'object' ? record.rules : undefined;
  if(!record || record.schemaVersion !== 1 || !Array.isArray(list) || list.length > categoryRuleLimit) {
    return {rules:[], repaired:true};
  }
  const rules: CategoryRule[] = [];
  const seen = new Set<string>();
  for(const entry of list) {
    const rule = ruleValue(entry);
    if(!rule) return {rules:[], repaired:true};
    const key = tokenKey(rule);
    if(seen.has(key)) return {rules:[], repaired:true};
    seen.add(key);
    rules.push(rule);
  }
  return {rules, repaired:false};
}

export function serializeCategoryRules(rules: readonly CategoryRule[]): string {
  return JSON.stringify({schemaVersion:1, rules:rules.slice(0, categoryRuleLimit).map(rule => ({
    kind:rule.kind, token:rule.token, category:rule.category,
    support:rule.support, purity:rule.purity, conflicts:rule.conflicts}))});
}

export function categoryRuleIndex(rules: readonly CategoryRule[]): CategoryRuleIndex {
  const index = new Map<string, CategoryRule[]>();
  for(const rule of rules) {
    const key = tokenKey(rule);
    const bucket = index.get(key);
    if(bucket) bucket.push(rule);
    else index.set(key, [rule]);
  }
  return index;
}

// 匹配：同名多个 token 时得分 log(1+support) × purity，取最高分；同分先取 support 大者，
// 再取页面类别配置中靠前的类别。规则指向已不存在的类别时视为未命中，继续回退。
export function matchCategoryRule(index: CategoryRuleIndex, frameName: string, config: CategoryConfig): CategoryRule | undefined {
  if(!index.size) return undefined;
  const names = config.categories.map(category => category.name);
  let best: {rule: CategoryRule; score: number} | undefined;
  for(const token of categoryTokens(frameName)) {
    const bucket = index.get(tokenKey(token));
    if(!bucket) continue;
    for(const rule of bucket) {
      if(!knownCategory(config, rule.category)) continue;
      const score = Math.log(1 + rule.support) * rule.purity;
      if(!best || score > best.score + 1e-12) { best = {rule, score}; continue; }
      if(Math.abs(score - best.score) > 1e-12) continue;
      if(rule.support > best.rule.support) { best = {rule, score}; continue; }
      if(rule.support < best.rule.support) continue;
      if(categoryIndex(names, rule.category) < categoryIndex(names, best.rule.category)) best = {rule, score};
    }
  }
  return best?.rule;
}

// 优先级：学到的命名族在前，未命中才回退前缀/关键词/尺寸。`learned` 供预览统计使用。
export function classify(input: CategoryInput, learned?: CategoryRuleIndex, config?: CategoryConfig): ClassifiedCategory {
  if(learned && config) {
    const rule = matchCategoryRule(learned, input.frameName, config);
    if(rule) return {category:rule.category, learned:true};
  }
  const name = input.frameName.toLocaleLowerCase();
  const token = name.match(/^[a-z]+/)?.[0];
  if(token) for(const rule of prefixRules) if(rule.prefixes.includes(token)) return {category:rule.category, learned:false};
  for(const rule of nameRules) if(rule.keywords.some(keyword => name.includes(keyword))) return {category:rule.category, learned:false};
  const width = input.width, height = input.height;
  if(!(width > 0 && height > 0)) return {category:unsortedCategory, learned:false};
  if(width >= 512 && height >= 512) return {category:'背景', learned:false};
  const small = Math.min(width,height), large = Math.max(width,height);
  if(small >= 8 && large <= 256 && large / small <= 1.5) return {category:'图标', learned:false};
  if(height >= 8 && height <= 96 && width >= height * 2.5 && width <= 1024) return {category:'按钮', learned:false};
  return {category:unsortedCategory, learned:false};
}

// Display name format: 分类/散图原名. `sourceInfo` is the source location and
// is only appended when two components in the same category share a name.
export function componentName(category: CategoryName, frameName: string, sourceInfo?: string): string {
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

export function knownCategory(config: CategoryConfig, value: unknown): CategoryName | undefined {
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
// 配置读回始终补齐「未分类」，所以这里不需要再回退到「第一个类别」。
export function categoryOr(config: CategoryConfig, name: CategoryName): CategoryName {
  return knownCategory(config, name) ? name : unsortedCategory;
}
