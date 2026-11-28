// Runs read-only DOM measurements in a CDP isolated world. Does not click or submit.
export function measure() {
  const issues = [], elements = [...document.querySelectorAll('body *')];
  const selector = el => { const parts = []; for (let node = el; node?.nodeType === 1 && parts.length < 6; node = node.parentElement) { let part = node.tagName.toLowerCase(); if (node.id) { parts.unshift(part + '#' + CSS.escape(node.id)); break; } const siblings = node.parentElement ? [...node.parentElement.children].filter(e => e.tagName === node.tagName) : []; if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'; parts.unshift(part); } return parts.join(' > '); };
  const add = (kind, el, details) => { if (issues.length < 1000) issues.push({ kind, selector: selector(el), ...details }); };
  const color = value => { const m = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
  const lum = rgb => rgb.slice(0, 3).map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((s, n, i) => s + n * [.2126, .7152, .0722][i], 0);
  // A descendant's own opacity is 1 even when an ancestor hides/composites it.
  // Keep the original measurement, but test overflow on its ancestor-clipped bounds.
  const appearance = (el, rect) => {
    let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
    let invisible = false, composited = false;
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (+s.opacity === 0 || s.contentVisibility === 'hidden') invisible = true;
      if (+s.opacity !== 1 || s.filter !== 'none' || s.backdropFilter !== 'none' || s.mixBlendMode !== 'normal') composited = true;
      if (node === el) continue;
      const clipX = ['hidden', 'clip', 'scroll', 'auto'].includes(s.overflowX);
      const clipY = ['hidden', 'clip', 'scroll', 'auto'].includes(s.overflowY);
      if (!clipX && !clipY) continue;
      const r = node.getBoundingClientRect();
      const scaleX = node.offsetWidth ? r.width / node.offsetWidth : 1;
      const scaleY = node.offsetHeight ? r.height / node.offsetHeight : 1;
      const x = r.left + node.clientLeft * scaleX, y = r.top + node.clientTop * scaleY;
      if (clipX) { left = Math.max(left, x); right = Math.min(right, x + node.clientWidth * scaleX); }
      if (clipY) { top = Math.max(top, y); bottom = Math.min(bottom, y + node.clientHeight * scaleY); }
    }
    return { invisible: invisible || right <= left || bottom <= top, composited, bounds: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) } };
  };
  let examined = 0;
  for (const el of elements.slice(0, 20000)) {
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility !== 'visible' || rect.width === 0 || rect.height === 0) continue;
    const visible = appearance(el, rect);
    if (visible.invisible) continue;
    examined++;
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    if (visible.bounds.x + visible.bounds.width > innerWidth + 1 || visible.bounds.x < -1) add('horizontal-overflow', el, { bounds, visibleBounds: visible.bounds, viewportWidth: innerWidth });
    if (el instanceof HTMLImageElement && (!el.complete || !el.naturalWidth)) add('image-unavailable', el, { src: el.currentSrc || el.src, complete: el.complete, bounds });
    if (el.matches('button,input:not([type=hidden]),select,textarea,a[href],[role=button]') && (rect.width < 24 || rect.height < 24)) add('small-target', el, { bounds, threshold: 24, certainty: 'heuristic; visible box is not necessarily the effective hit area' });
    const directText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!directText) continue;
    if (+parseFloat(style.fontSize) < 12) add('small-text', el, { fontSize: style.fontSize, bounds, threshold: 12 });
    const clippingX = ['hidden', 'clip'].includes(style.overflowX), clippingY = ['hidden', 'clip'].includes(style.overflowY);
    if ((clippingX && el.scrollWidth > el.clientWidth + 1) || (clippingY && el.scrollHeight > el.clientHeight + 1)) add('possible-text-clipped', el, { bounds, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, certainty: 'heuristic; intentional ellipsis can be valid' });
    const fg = color(style.color); let bg = null, complex = visible.composited;
    for (let node = el; !complex && node; node = node.parentElement) {
      const s = getComputedStyle(node); if (s.backgroundImage !== 'none') { complex = true; break; }
      const c = color(s.backgroundColor); if (c && c[3] === 1) { bg = c; break; } if (c && c[3] !== 0) { complex = true; break; }
    }
    if (!bg && !complex) bg = [255, 255, 255, 1];
    if (fg && fg[3] === 1 && bg && !complex) { const a = lum(fg), b = lum(bg), ratio = (Math.max(a,b)+.05)/(Math.min(a,b)+.05); const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && +style.fontWeight >= 700); const threshold = large ? 3 : 4.5; if (ratio < threshold) add('heuristic-low-contrast', el, { ratio: +ratio.toFixed(2), threshold, foreground: style.color, background: bg.slice(0,3), certainty: 'heuristic; no image/gradient/compositing analysis' }); }
  }
  return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, page: { width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0), height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) }, examinedElements: examined, totalElements: elements.length, truncated: elements.length > 20000 || issues.length >= 1000, issues };
}
