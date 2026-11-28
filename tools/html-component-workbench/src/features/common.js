/*
 * 工作台特性共用工具：惰性解析、沙箱预览文档、引用图与复核语义的唯一实现。
 * 文件名 common.js 按构建的字典序先于 extraction/files/relations 加载，只定义
 * window.WorkbenchCommon，不注册特性。
 */
(() => {
  'use strict';
  // 惰性解析组件稿 HTML：DOMParser 文档不执行脚本，也不插入宿主可执行 DOM。
  function fragment(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const result = document.createDocumentFragment();
    for (const child of Array.from(doc.body.childNodes)) result.append(document.importNode(child, true));
    return result;
  }
  function serialize(nodes) {
    const container = document.createElement('div');
    container.append(nodes);
    return container.innerHTML;
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function previewDocument(content) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}' + content.css.replace(/<\/style/gi, '<\\/style') + '</style></head><body>' + content.html + '</body></html>';
  }
  const PREVIEW_ZOOM = {min: 0.5, max: 2, step: 0.25};
  function clampPreviewScale(scale) {
    return Math.min(PREVIEW_ZOOM.max, Math.max(PREVIEW_ZOOM.min, Math.round(scale / PREVIEW_ZOOM.step) * PREVIEW_ZOOM.step));
  }
  // 组件稿预览只做视觉缩放，不修改组件稿宽度/高度或保存内容。
  function createScaledDraftFrame(draft, scale) {
    const viewport = document.createElement('div');
    viewport.className = 'draft-preview-viewport';
    viewport.style.width = draft.content.width * scale + 'px';
    viewport.style.height = draft.content.height * scale + 'px';
    const frame = document.createElement('iframe');
    frame.title = '组件稿：' + draft.name;
    frame.setAttribute('sandbox', '');
    frame.width = draft.content.width;
    frame.height = draft.content.height;
    if (scale !== 1) frame.style.transform = 'scale(' + scale + ')';
    frame.srcdoc = previewDocument(draft.content);
    viewport.append(frame);
    return {viewport, frame};
  }
  function createZoomToolbar(scale, onChange) {
    const toolbar = document.createElement('div');
    toolbar.className = 'preview-zoom';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '组件稿预览缩放');
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.textContent = '缩小组件稿';
    zoomOut.disabled = scale <= PREVIEW_ZOOM.min;
    zoomOut.onclick = () => onChange(clampPreviewScale(scale - PREVIEW_ZOOM.step));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '1:1 原始尺寸';
    reset.setAttribute('aria-pressed', String(scale === 1));
    reset.onclick = () => onChange(1);
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.textContent = '放大组件稿';
    zoomIn.disabled = scale >= PREVIEW_ZOOM.max;
    zoomIn.onclick = () => onChange(clampPreviewScale(scale + PREVIEW_ZOOM.step));
    const label = document.createElement('span');
    label.className = 'preview-zoom-label';
    label.setAttribute('role', 'status');
    label.textContent = '预览比例 ' + Math.round(scale * 100) + '%';
    toolbar.append(zoomOut, reset, zoomIn, label);
    return toolbar;
  }

  function wouldCreateCycle(references, ownerId, targetId) {
    const visited = new Set();
    const stack = [targetId];
    while (stack.length) {
      const id = stack.pop();
      if (id === ownerId) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const ref of references) if (ref.ownerDraftId === id) stack.push(ref.targetDraftId);
    }
    return false;
  }
  function hasUnresolvedReview(project, reviewId) {
    if (!reviewId) return false;
    const review = project.reviews.find(item => item.id === reviewId);
    return !review || !review.resolved;
  }
  function isEffectiveMapping(project, mapping) {
    return mapping.status === 'confirmed' && !hasUnresolvedReview(project, mapping.reviewId);
  }
  // 稳定节点之间的祖先关系只由 data-wb-node 决定，不依赖显示名或 DOM 层级序号。
  function slotParentMap(root) {
    const parent = new Map();
    for (const node of root.querySelectorAll('[data-wb-node]')) {
      const id = node.getAttribute('data-wb-node');
      const container = node.parentElement?.closest('[data-wb-node]');
      parent.set(id, container ? container.getAttribute('data-wb-node') : null);
    }
    return parent;
  }
  function isSlotAncestorOrSelf(parent, ancestor, node) {
    for (let current = node; current; current = parent.get(current)) if (current === ancestor) return true;
    return false;
  }
  function slotsOverlap(parent, first, second) {
    return isSlotAncestorOrSelf(parent, first, second) || isSlotAncestorOrSelf(parent, second, first);
  }
  function overlappingSlot(parent, candidate, existing) {
    for (const id of existing) if (slotsOverlap(parent, candidate, id)) return id;
    return null;
  }
  window.WorkbenchCommon = {element, fragment, serialize, previewDocument, PREVIEW_ZOOM, clampPreviewScale, createScaledDraftFrame, createZoomToolbar, wouldCreateCycle, hasUnresolvedReview, isEffectiveMapping, slotParentMap, slotsOverlap, overlappingSlot};
})();
