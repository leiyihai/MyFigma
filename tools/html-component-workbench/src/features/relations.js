/*
 * Relations Module (#33): public Interface = 组件 TAB 的关系概览、左侧组件组操作、
 * 右侧嵌套引用/来源映射操作，以及在概览里进入独立或同组预览。所有关系都来自项目资料
 * （groups/references/mappings），不从画面连线反推事实。
 * 引用更新通过 draft:update guard 预览影响：确认后在同一深副本里同步使用方共享结构，
 * 取消、冲突或覆盖无法安全保留时整笔不提交。候选映射不是强制复用约束。
 */
(() => {
  'use strict';
  let ctx;
  let groupName = '';
  let preview = null;
  let previewScale = 1;
  let pendingImpactPlan = null;
  let impactConfirmationResolve = null;
  let referenceFormOwnerId = null, referenceFormTargetId = null, referenceFormSlotId = null, referenceFormSignature = null;
  let overrideValues = new Map();
  let candidateDraftId = null;
  let mappingSelection = new Set();
  let mappingProjectId = null;

  const el = WorkbenchCommon.element;
  function button(text, action, options = {}) {
    const node = el('button', text, options.className);
    node.type = 'button';
    node.disabled = Boolean(options.disabled);
    if (options.label) node.setAttribute('aria-label', options.label);
    if (options.pressed !== undefined) node.setAttribute('aria-pressed', String(options.pressed));
    node.onclick = async () => {
      try { await action(); } catch (error) { ctx.notify(error.message, true); }
    };
    return node;
  }
  const draftById = (project, id) => project.drafts.find(draft => draft.id === id);
  const draftName = (project, id) => draftById(project, id)?.name || '已删除组件';
  function groupOf(project, draftId) {
    return project.groups.find(group => group.memberIds.includes(draftId));
  }
  function roleOf(project, draftId) {
    const group = groupOf(project, draftId);
    if (!group) return '独立';
    return group.primaryId === draftId ? '主体' : '变体';
  }
  function groupMembers(group) {
    return [group.primaryId, ...group.memberIds.filter(id => id !== group.primaryId)];
  }
  function selectedGroup(project, ui) {
    const selected = ui.selectedDraftIds.filter(id => draftById(project, id));
    const groups = project.groups.filter(group => selected.some(id => group.memberIds.includes(id)));
    return groups.length === 1 && selected.every(id => groups[0].memberIds.includes(id)) ? groups[0] : null;
  }
  const unresolvedReview = WorkbenchCommon.hasUnresolvedReview;
  const effectiveMapping = WorkbenchCommon.isEffectiveMapping;
  const fragment = WorkbenchCommon.fragment;
  const serialize = WorkbenchCommon.serialize;

  // ---------- 组件内容工具（只解析惰性组件稿 HTML，不执行内容） ----------
  function contentNodes(html) {
    return [...fragment(html).querySelectorAll('[data-wb-node]')].map(node => ({
      id: node.getAttribute('data-wb-node'),
      tag: node.tagName.toLowerCase(),
      text: (node.textContent || '').trim().slice(0, 32)
    }));
  }
  function textOnlyNodes(html) {
    return [...fragment(html).querySelectorAll('[data-wb-node]')]
      .filter(node => !node.childElementCount && node.textContent.trim())
      .map(node => ({id: node.getAttribute('data-wb-node'), text: node.textContent}));
  }
  function tagOf(html, nodeId) {
    const node = [...fragment(html).querySelectorAll('[data-wb-node]')].find(item => item.getAttribute('data-wb-node') === nodeId);
    return node ? node.tagName.toLowerCase() : null;
  }
  function slotCandidates(project, owner) {
    const used = new Set(project.references.filter(ref => ref.ownerDraftId === owner.id).map(ref => ref.slotNodeId));
    return contentNodes(owner.content.html).filter(node => !used.has(node.id));
  }
  function stripRefCss(css, refId) {
    const start = '/*wb-ref:' + refId + ':start*/', end = '/*wb-ref:' + refId + ':end*/';
    const from = css.indexOf(start);
    if (from < 0) return css;
    const to = css.indexOf(end, from);
    if (to < 0) return css.slice(0, from);
    return (css.slice(0, from) + css.slice(to + end.length)).trim();
  }
  function snapshotPrefix(refId) {
    return 'wb-ref-' + refId.replace(/[^a-zA-Z0-9_-]/g, '') + '-';
  }
  // 目标组件稿的样式只能作用于本次引用根内部；宽泛选择器不得改写使用方其他内容。
  function splitSelectors(selectorText) {
    const parts = [];
    let start = 0, depth = 0, quote = null;
    for (let index = 0; index < selectorText.length; index++) {
      const character = selectorText[index];
      if (quote) {
        if (character === '\\') index++;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '(' || character === '[') { depth++; continue; }
      if (character === ')' || character === ']') { depth = Math.max(0, depth - 1); continue; }
      if (character === ',' && depth === 0) { parts.push(selectorText.slice(start, index).trim()); start = index + 1; }
    }
    parts.push(selectorText.slice(start).trim());
    return parts.filter(Boolean);
  }
  function scopedSelector(selector, scope) {
    const trimmed = selector.trim();
    return [':root', 'html', 'body'].includes(trimmed.toLowerCase()) ? scope : scope + ' ' + trimmed;
  }
  function scopeCssRule(rule, scope) {
    if (typeof rule.selectorText === 'string') {
      if (rule.cssRules?.length) throw Error('引用目标包含嵌套 CSS 规则，无法安全隔离样式作用域');
      return splitSelectors(rule.selectorText).map(selector => scopedSelector(selector, scope) + ' {' + rule.style.cssText + '}').join('\n');
    }
    if (rule instanceof CSSFontFaceRule) return rule.cssText;
    if (rule instanceof CSSMediaRule) return '@media ' + rule.conditionText + ' {\n' + [...rule.cssRules].map(child => scopeCssRule(child, scope)).join('\n') + '\n}';
    if (rule instanceof CSSSupportsRule) return '@supports ' + rule.conditionText + ' {\n' + [...rule.cssRules].map(child => scopeCssRule(child, scope)).join('\n') + '\n}';
    if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) return '@container ' + rule.conditionText + ' {\n' + [...rule.cssRules].map(child => scopeCssRule(child, scope)).join('\n') + '\n}';
    if (rule instanceof CSSKeyframesRule) throw Error('引用目标的 @keyframes 动画无法隔离到引用作用域');
    throw Error('引用目标包含无法隔离的样式规则：' + (rule.cssText || rule.constructor.name).slice(0, 80));
  }
  function scopeCss(css, refId) {
    if (!css.trim()) return '';
    let sheet;
    try { sheet = new CSSStyleSheet(); sheet.replaceSync(css); }
    catch (error) { throw Error('无法解析被引用组件样式：' + error.message); }
    const escaped = refId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const scope = '[data-wb-ref-root="' + escaped + '"]';
    return [...sheet.cssRules].map(rule => scopeCssRule(rule, scope)).join('\n');
  }

  // 把 target 的共享结构真实写入 owner 的 slot，并只重放该位置的 typed 覆盖。
  function embedReference(content, ref, target, previousTarget) {
    const root = fragment(content.html);
    const slot = [...root.querySelectorAll('[data-wb-node]')].find(node => node.getAttribute('data-wb-node') === ref.slotNodeId);
    if (!slot) throw Error('引用位置“' + ref.slotNodeId + '”不存在');
    if (!target.content?.html) throw Error('被引用组件没有可共享结构');
    const shared = fragment(target.content.html);
    if (!shared.childNodes.length) throw Error('被引用组件共享结构为空');
    const prefix = snapshotPrefix(ref.id);
    for (const node of [...shared.querySelectorAll('[data-wb-node]')]) {
      const id = node.getAttribute('data-wb-node');
      node.removeAttribute('data-wb-node');
      node.setAttribute('data-wb-ref-node', id);
    }
    for (const node of [...shared.querySelectorAll('[data-wb-snapshot]')]) {
      const token = node.getAttribute('data-wb-snapshot');
      node.removeAttribute('data-wb-snapshot');
      node.setAttribute('data-wb-ref-snapshot', prefix + token);
    }
    const container = document.createElement('div');
    container.setAttribute('data-wb-ref-root', ref.id);
    container.setAttribute('data-wb-ref-target', target.id);
    container.setAttribute('data-wb-ref-revision', String(target.revision));
    container.setAttribute('style', 'position:relative;display:block;width:' + target.content.width + 'px;height:' + target.content.height + 'px;overflow:hidden;flex:none');
    container.append(shared);
    for (const override of ref.overrides) {
      const matches = [...container.querySelectorAll('[data-wb-ref-node]')].filter(node => node.getAttribute('data-wb-ref-node') === override.nodeId);
      if (!matches.length) throw Error('覆盖节点“' + override.nodeId + '”在新共享结构中不存在，无法安全保留覆盖');
      for (const node of matches) {
        if (node.childElementCount) throw Error('覆盖节点“' + override.nodeId + '”包含子结构，无法安全保留文字覆盖');
        if (previousTarget) {
          const before = tagOf(previousTarget.html, override.nodeId);
          if (before && node.tagName.toLowerCase() !== before) throw Error('覆盖节点“' + override.nodeId + '”的类型已变化（' + before + ' → ' + node.tagName.toLowerCase() + '），无法安全保留覆盖');
        }
        node.textContent = override.value;
      }
    }
    slot.replaceChildren(container);
    const renamedCss = target.content.css.replace(/\[data-wb-snapshot="([^"]*)"\]/g, (match, token) => '[data-wb-ref-snapshot="' + prefix + token + '"]');
    if (/data-wb-snapshot/.test(renamedCss)) throw Error('被引用组件包含无法隔离的快照选择器，请重新提取组件稿');
    const css = scopeCss(renamedCss, ref.id);
    let nextCss = stripRefCss(content.css, ref.id);
    if (css.trim()) nextCss = nextCss.replace(/\s+$/, '') + '\n/*wb-ref:' + ref.id + ':start*/\n' + css + '\n/*wb-ref:' + ref.id + ':end*/';
    return {...content, html: serialize(root), css: nextCss};
  }
  function removeEmbedded(content, refId) {
    const root = fragment(content.html);
    const markers = [...root.querySelectorAll('[data-wb-ref-root]')].filter(node => node.getAttribute('data-wb-ref-root') === refId);
    const css = stripRefCss(content.css, refId);
    if (!markers.length) return {content: {...content, html: serialize(root)}, changed: css !== content.css};
    for (const marker of markers) marker.remove();
    return {content: {...content, html: serialize(root), css}, changed: true};
  }

  // ---------- 引用图 ----------
  const wouldCreateCycle = (project, ownerId, targetId) => WorkbenchCommon.wouldCreateCycle(project.references, ownerId, targetId);
  // 把已经改变内容的使用方（含传递使用方）按依赖顺序重新展开共享结构并重放覆盖。
  function reflowUpstreamOwners(project, changedIds, previousContents = new Map()) {
    const ownersOf = new Map();
    for (const ref of project.references) {
      if (!ownersOf.has(ref.targetDraftId)) ownersOf.set(ref.targetDraftId, []);
      ownersOf.get(ref.targetDraftId).push(ref.ownerDraftId);
    }
    const affected = new Set(changedIds);
    const queue = [...changedIds];
    while (queue.length) {
      const id = queue.shift();
      for (const owner of ownersOf.get(id) || []) if (!affected.has(owner)) { affected.add(owner); queue.push(owner); }
    }
    const visited = new Set(), ordered = [];
    function visit(id) {
      if (visited.has(id)) return;
      visited.add(id);
      for (const owner of ownersOf.get(id) || []) if (affected.has(owner)) visit(owner);
      ordered.push(id);
    }
    for (const id of affected) visit(id);
    const rebuildOrder = ordered.reverse().filter(id => !changedIds.includes(id));
    const updated = new Set([...changedIds, ...rebuildOrder]);
    for (const id of rebuildOrder) {
      const index = project.drafts.findIndex(draft => draft.id === id);
      const draft = project.drafts[index];
      let content = draft.content;
      for (const ref of project.references.filter(item => item.ownerDraftId === id)) {
        const target = draftById(project, ref.targetDraftId);
        if (!target) continue;
        try { content = embedReference(content, ref, target, previousContents.get(ref.targetDraftId) || null); }
        catch (error) { throw Error('无法同步使用方“' + draft.name + '”的引用位置“' + ref.slotNodeId + '”：' + error.message); }
      }
      project.drafts[index] = {...draft, content, revision: draft.revision + 1};
    }
    // 只推进本次真正重建/更新的目标，未参与本次传播的引用保持原修订状态。
    for (const ref of project.references) {
      if (!updated.has(ref.targetDraftId)) continue;
      const target = draftById(project, ref.targetDraftId);
      if (target) ref.targetRevision = target.revision;
    }
  }
  function contentSignature(draft) {
    return JSON.stringify([draft?.content?.html, draft?.content?.css, draft?.content?.width, draft?.content?.height]);
  }
  // 汇总一次内容变更向上游传播时会影响的使用方及其引用位置，供影响面板与 guard 共用。
  function upstreamImpact(project, rootId, simulated, targetName, newRevision) {
    const changedTargets = new Set(simulated.drafts.filter((draft, position) => contentSignature(draft) !== contentSignature(project.drafts[position]) || draft.revision !== project.drafts[position].revision).map(draft => draft.id));
    const ownersOf = new Map();
    for (const ref of simulated.references) {
      if (!ownersOf.has(ref.targetDraftId)) ownersOf.set(ref.targetDraftId, []);
      ownersOf.get(ref.targetDraftId).push(ref.ownerDraftId);
    }
    const owners = [], seen = new Set([rootId]), queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      for (const ownerId of ownersOf.get(id) || []) {
        if (seen.has(ownerId)) continue;
        seen.add(ownerId);
        queue.push(ownerId);
        const owner = draftById(simulated, ownerId);
        if (!owner) continue;
        const refs = simulated.references.filter(ref => ref.ownerDraftId === ownerId && (ref.targetDraftId === rootId || changedTargets.has(ref.targetDraftId)))
          .map(ref => ({slotNodeId: ref.slotNodeId, targetName: draftName(simulated, ref.targetDraftId), overrides: ref.overrides.map(override => ({nodeId: override.nodeId, value: override.value}))}));
        owners.push({id: ownerId, name: owner.name, refs});
      }
    }
    return {targetName, newRevision, owners};
  }
  // 计算一次 draft:update 的完整影响，但先不写回项目；guard 确认后才返回同步 apply。
  function planDraftUpdate(project, draftId, nextDraft) {
    const old = draftById(project, draftId);
    if (!old || !nextDraft) return null;
    if (contentSignature(old) === contentSignature(nextDraft)) return null;
    const involved = project.references.some(ref => ref.ownerDraftId === draftId || ref.targetDraftId === draftId);
    if (!involved) return null;
    const previousContents = new Map(project.drafts.map(draft => [draft.id, structuredClone(draft.content)]));
    const simulated = structuredClone(project);
    const index = simulated.drafts.findIndex(draft => draft.id === draftId);
    const revision = Number.isInteger(nextDraft.revision) ? nextDraft.revision : old.revision + 1;
    simulated.drafts[index] = {...structuredClone(nextDraft), revision};
    let content = simulated.drafts[index].content;
    for (const ref of simulated.references.filter(item => item.ownerDraftId === draftId)) {
      const target = draftById(simulated, ref.targetDraftId);
      if (!target) throw Error('引用目标“' + ref.targetDraftId + '”不存在，未提交更新');
      try { content = embedReference(content, ref, target, previousContents.get(ref.targetDraftId) || null); }
      catch (error) { throw Error('无法保留“' + old.name + '”的引用位置“' + ref.slotNodeId + '”：' + error.message + '，未提交更新'); }
    }
    simulated.drafts[index] = {...simulated.drafts[index], content};
    reflowUpstreamOwners(simulated, [draftId], previousContents);
    const draftPatches = simulated.drafts.filter((draft, position) => JSON.stringify(draft) !== JSON.stringify(project.drafts[position])).map(draft => structuredClone(draft));
    const refPatches = simulated.references.map((ref, position) => ref.targetRevision !== project.references[position].targetRevision ? {id: ref.id, targetRevision: ref.targetRevision} : null).filter(Boolean);
    const impact = upstreamImpact(project, draftId, simulated, old.name, simulated.drafts[index].revision);
    return {
      ...impact,
      apply(nextProject) {
        for (const draft of draftPatches) {
          const position = nextProject.drafts.findIndex(item => item.id === draft.id);
          if (position < 0) throw Error('组件稿已不存在，引用同步已取消');
          nextProject.drafts[position] = structuredClone(draft);
        }
        for (const patch of refPatches) {
          const ref = nextProject.references.find(item => item.id === patch.id);
          if (!ref) throw Error('引用关系已不存在，引用同步已取消');
          ref.targetRevision = patch.targetRevision;
        }
      }
    };
  }
  function confirmImpact(plan) {
    pendingImpactPlan = plan;
    render();
    return new Promise(resolve => { impactConfirmationResolve = resolve; });
  }
  function resolveImpact(confirmed) {
    const resolve = impactConfirmationResolve;
    impactConfirmationResolve = null;
    pendingImpactPlan = null;
    render();
    if (resolve) resolve(confirmed);
  }
  function commitProject(next) {
    ctx.updateProject(current => { for (const key of Object.keys(next)) current[key] = next[key]; });
  }

  // ---------- 组件组 ----------
  function defineGroup() {
    const project = ctx.getProject(), ui = ctx.getUI();
    const selected = ui.selectedDraftIds.filter(id => draftById(project, id));
    if (selected.length < 2) throw Error('请先在组件列表按实际顺序勾选至少两个组件稿');
    const primaryId = selected[0];
    const intersecting = project.groups.filter(group => group.memberIds.some(id => selected.includes(id)));
    const name = groupName.trim() || (intersecting.length === 1 ? intersecting[0].name : draftName(project, primaryId) + ' 组');
    const affected = project.references.filter(ref => selected.includes(ref.ownerDraftId) || selected.includes(ref.targetDraftId));
    let notice;
    ctx.updateProject(next => {
      let group;
      if (intersecting.length === 1) {
        group = next.groups.find(item => item.id === intersecting[0].id);
        group.primaryId = primaryId;
        group.memberIds = [...selected];
        group.name = name;
      } else {
        group = {id: 'group-' + crypto.randomUUID(), name, primaryId, memberIds: [...selected]};
        next.groups.push(group);
      }
      for (const existing of next.groups) {
        if (existing === group) continue;
        existing.memberIds = existing.memberIds.filter(id => !selected.includes(id));
        if (existing.memberIds.length && !existing.memberIds.includes(existing.primaryId)) existing.primaryId = existing.memberIds[0];
      }
      next.groups = next.groups.filter(item => item.memberIds.length);
      notice = '已定义组件组：' + name + '；主体：' + draftName(next, primaryId) + (affected.length ? '；' + affected.length + ' 条引用关系保留，未自动解除' : '');
    });
    groupName = name;
    ctx.notify(notice);
  }
  function dissolveGroup() {
    const project = ctx.getProject(), ui = ctx.getUI();
    const group = selectedGroup(project, ui) || groupOf(project, ui.activeDraftId);
    if (!group) throw Error('请勾选同一组件组内的组件稿，或先在概览中选中该组成员');
    const affected = project.references.filter(ref => group.memberIds.includes(ref.ownerDraftId) || group.memberIds.includes(ref.targetDraftId));
    ctx.updateProject(next => { next.groups = next.groups.filter(item => item.id !== group.id); });
    ctx.notify('组件组已解散；嵌套引用关系仍保留。' + (affected.length ? ' 涉及 ' + affected.length + ' 条引用，请检查其影响。' : ''));
  }

  // ---------- 引用操作 ----------
  function ensureForm(project, active) {
    if (referenceFormOwnerId !== active.id) {
      referenceFormOwnerId = active.id;
      referenceFormTargetId = project.drafts.find(draft => draft.id !== active.id)?.id || null;
      referenceFormSlotId = null;
      referenceFormSignature = null;
      overrideValues = new Map();
    }
    if (!draftById(project, referenceFormTargetId)) referenceFormTargetId = project.drafts.find(draft => draft.id !== active.id)?.id || null;
    const key = referenceFormOwnerId + '|' + referenceFormTargetId;
    if (key !== referenceFormSignature) {
      referenceFormSignature = key;
      overrideValues = new Map();
      const target = draftById(project, referenceFormTargetId);
      if (target) for (const node of textOnlyNodes(target.content.html)) overrideValues.set(node.id, node.text);
    }
    const slots = slotCandidates(project, active);
    if (!slots.some(slot => slot.id === referenceFormSlotId)) referenceFormSlotId = slots[0]?.id || null;
  }
  function applyReferenceCreation(next, ref) {
    const owner = draftById(next, ref.ownerDraftId), target = draftById(next, ref.targetDraftId);
    if (!owner || !target) throw Error('引用组件已变化，引用建立已取消');
    const previousContents = new Map(next.drafts.map(draft => [draft.id, structuredClone(draft.content)]));
    const index = next.drafts.findIndex(draft => draft.id === owner.id);
    let content;
    try { content = embedReference(owner.content, ref, target, null); }
    catch (error) { throw Error('无法建立引用：' + error.message + '，未提交'); }
    next.drafts[index] = {...next.drafts[index], content, revision: owner.revision + 1};
    next.references.push(structuredClone(ref));
    reflowUpstreamOwners(next, [owner.id], previousContents);
  }
  async function createReferenceGuard(payload) {
    const project = ctx.getProject(), ref = payload.ref;
    const owner = draftById(project, ref?.ownerDraftId), target = draftById(project, ref?.targetDraftId);
    if (!owner || !target) throw Error('引用组件已变化，请重新选择');
    if (owner.id === target.id) throw Error('不能引用自身：请选择另一个组件稿');
    const ownerNodes = fragment(owner.content.html);
    if (!contentNodes(owner.content.html).some(node => node.id === ref.slotNodeId)) throw Error('引用位置“' + ref.slotNodeId + '”在组件稿中不存在');
    const existingSlots = project.references.filter(item => item.ownerDraftId === owner.id).map(item => item.slotNodeId);
    const overlapping = WorkbenchCommon.overlappingSlot(WorkbenchCommon.slotParentMap(ownerNodes), ref.slotNodeId, existingSlots);
    if (overlapping) throw Error('引用位置“' + ref.slotNodeId + '”与既有引用位置“' + overlapping + '”重叠（互为祖先或后代），无法同时保留');
    if (wouldCreateCycle(project, owner.id, target.id)) throw Error('该引用会形成循环（' + owner.name + ' ↔ ' + target.name + '），已拒绝');
    const simulated = structuredClone(project);
    applyReferenceCreation(simulated, ref);
    const index = simulated.drafts.findIndex(draft => draft.id === owner.id);
    const impact = upstreamImpact(project, owner.id, simulated, owner.name, simulated.drafts[index].revision);
    const apply = next => applyReferenceCreation(next, ref);
    if (!impact.owners.length) return apply;
    Object.assign(impact, {
      heading: '建立引用影响',
      intro: '建立引用会更新使用方“' + owner.name + '”；' + impact.owners.length + ' 个使用方的共享结构将同步，以下覆盖会保留：',
      confirmLabel: '确认建立并同步',
      cancelLabel: '取消建立'
    });
    return (await confirmImpact(impact)) ? apply : false;
  }
  async function createReference() {
    const project = ctx.getProject(), ui = ctx.getUI();
    const owner = draftById(project, ui.activeDraftId);
    if (!owner) throw Error('请先在概览中选择使用方组件');
    const target = draftById(project, referenceFormTargetId);
    if (!target) throw Error('请选择被引用组件');
    if (owner.id === target.id) throw Error('不能引用自身：请选择另一个组件稿');
    if (!referenceFormSlotId) throw Error('请选择引用位置');
    const ownerNodes = fragment(owner.content.html);
    if (!contentNodes(owner.content.html).some(node => node.id === referenceFormSlotId)) throw Error('引用位置“' + referenceFormSlotId + '”在组件稿中不存在');
    const existingSlots = project.references.filter(ref => ref.ownerDraftId === owner.id).map(ref => ref.slotNodeId);
    const overlapping = WorkbenchCommon.overlappingSlot(WorkbenchCommon.slotParentMap(ownerNodes), referenceFormSlotId, existingSlots);
    if (overlapping) throw Error('引用位置“' + referenceFormSlotId + '”与既有引用位置“' + overlapping + '”重叠（互为祖先或后代），无法同时保留；请选择不包含既有引用的位置');
    if (wouldCreateCycle(project, owner.id, target.id)) throw Error('该引用会形成循环（' + owner.name + ' ↔ ' + target.name + '），已拒绝；请先移除冲突的引用');
    const defaults = new Map(textOnlyNodes(target.content.html).map(node => [node.id, node.text]));
    const overrides = [];
    for (const [nodeId, text] of defaults) {
      const value = overrideValues.get(nodeId);
      if (value !== undefined && value !== text) overrides.push({nodeId, kind: 'text', value});
    }
    const ref = {id: 'ref-' + crypto.randomUUID(), ownerDraftId: owner.id, targetDraftId: target.id, slotNodeId: referenceFormSlotId, overrides, targetRevision: target.revision};
    const committed = await ctx.runCommand('reference:create', {ref}, () => {});
    if (!committed) { ctx.notify('已取消建立引用，项目未改动'); return; }
    ctx.notify('已建立嵌套引用：' + owner.name + ' → ' + target.name + '；共享结构已嵌入位置 ' + ref.slotNodeId + (overrides.length ? '，保留 ' + overrides.length + ' 处覆盖' : ''));
    referenceFormTargetId = null;
    referenceFormSlotId = null;
    referenceFormSignature = null;
    overrideValues = new Map();
    render();
  }
  function deleteReference(refId) {
    const project = ctx.getProject();
    const ref = project.references.find(item => item.id === refId);
    if (!ref) throw Error('引用已不存在');
    const owner = draftById(project, ref.ownerDraftId);
    if (project.references.some(item => item.targetDraftId === owner.id)) throw Error('该组件稿正被其他组件引用；删除其内部引用会改变使用方共享结构，请先处理使用方引用。');
    const next = structuredClone(project);
    next.references = next.references.filter(item => item.id !== refId);
    const removed = removeEmbedded(owner.content, refId);
    const index = next.drafts.findIndex(draft => draft.id === owner.id);
    next.drafts[index] = {...next.drafts[index], content: removed.content, revision: removed.changed ? owner.revision + 1 : owner.revision};
    if (removed.changed) reflowUpstreamOwners(next, [owner.id], new Map(project.drafts.map(draft => [draft.id, structuredClone(draft.content)])));
    commitProject(next);
    ctx.notify('已删除嵌套引用：' + owner.name + ' → ' + draftName(project, ref.targetDraftId) + '；' + (removed.changed ? '引用位置的共享结构已移除' : '组件稿未包含可移除的共享结构，原内容保留'));
  }

  // ---------- 来源复用映射 ----------
  function mappingStatusLabel(project, mapping) {
    if (mapping.status === 'candidate') return '候选';
    if (mapping.status === 'excluded') return '已排除';
    return unresolvedReview(project, mapping.reviewId) ? '已确认（待复核，非当前有效约束）' : '已确认（有效）';
  }
  function markCandidate() {
    const project = ctx.getProject(), ui = ctx.getUI();
    if (ui.mode !== 'edit') throw Error('请先进入编辑模式并选择原型内容');
    if (!ui.selection.length) throw Error('请先在原型中选择内容');
    const draft = draftById(project, candidateDraftId) || draftById(project, ui.activeDraftId);
    if (!draft) throw Error('请选择要标记复用的组件稿');
    const source = {prototypeId: project.prototype.manifest.id, pageId: ui.pageId, stateId: ui.stateId, nodeIds: [...ui.selection]};
    if (project.mappings.some(mapping => mapping.draftId === draft.id && mapping.source.prototypeId === source.prototypeId && mapping.source.pageId === source.pageId && mapping.source.stateId === source.stateId && JSON.stringify(mapping.source.nodeIds) === JSON.stringify(source.nodeIds))) throw Error('相同组件稿与来源的映射已存在');
    const mapping = {id: 'mapping-' + crypto.randomUUID(), draftId: draft.id, source, status: 'candidate', reviewId: null};
    ctx.updateProject(next => { next.mappings.push(mapping); });
    ctx.notify('已标记候选复用：' + draft.name + ' · ' + source.nodeIds.join('、') + '（候选不是强制约束）');
    mappingSelection.clear();
    render();
  }
  function setMappingsStatus(status) {
    const project = ctx.getProject();
    const selected = project.mappings.filter(mapping => mappingSelection.has(mapping.id));
    if (!selected.length) throw Error('请先勾选要处理的来源映射');
    ctx.updateProject(next => {
      for (const mapping of next.mappings) if (selected.some(item => item.id === mapping.id)) mapping.status = status;
    });
    const pending = selected.filter(mapping => status === 'confirmed' && unresolvedReview(project, mapping.reviewId)).length;
    mappingSelection.clear();
    ctx.notify((status === 'confirmed' ? '已确认 ' : '已排除 ') + selected.length + ' 条来源映射' + (pending ? '；其中 ' + pending + ' 条带未解决复核，不计为有效约束' : ''));
    render();
  }
  function mappingPanel(project, ui) {
    const panel = el('section', undefined, 'relations-panel relations-mappings');
    panel.append(el('h3', '来源复用映射'));
    panel.append(el('p', '候选来自编辑模式选区的人工标记；候选不会成为强制复用约束。', 'relations-help'));
    if (ui.mode === 'edit') {
      if (ui.selection.length) {
        if (!draftById(project, candidateDraftId)) candidateDraftId = draftById(project, ui.activeDraftId)?.id || project.drafts[0]?.id || null;
        const label = el('label', '候选复用组件', 'relations-field');
        const select = document.createElement('select');
        select.setAttribute('aria-label', '候选复用组件');
        for (const draft of project.drafts) {
          const option = document.createElement('option');
          option.value = draft.id;
          option.textContent = draft.name;
          option.selected = draft.id === candidateDraftId;
          select.append(option);
        }
        select.onchange = () => { candidateDraftId = select.value; render(); };
        label.append(select);
        panel.append(label, button('标记候选映射', markCandidate));
        panel.append(el('p', '当前选区：' + ui.selection.join('、'), 'relations-help'));
      } else {
        panel.append(el('p', '在原型编辑模式选择内容后，可标记候选复用来源。', 'relations-help'));
      }
    } else if (!project.mappings.length) {
      panel.append(el('p', '进入编辑模式选择原型内容，可标记候选复用来源。', 'relations-help'));
    }
    const list = el('div', undefined, 'relations-mapping-list');
    if (!project.mappings.length) list.append(el('p', '尚无来源映射。', 'relations-help'));
    for (const mapping of project.mappings) {
      const draft = draftById(project, mapping.draftId);
      const row = el('label', undefined, 'relations-mapping');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = mappingSelection.has(mapping.id);
      checkbox.setAttribute('aria-label', '选择映射：' + (draft?.name || mapping.draftId) + ' · ' + mapping.source.nodeIds.join('、'));
      checkbox.onchange = () => {
        if (checkbox.checked) mappingSelection.add(mapping.id); else mappingSelection.delete(mapping.id);
        render();
      };
      const body = el('span', undefined, 'relations-mapping-body');
      body.append(el('strong', (draft?.name || mapping.draftId) + ' · ' + mapping.source.pageId + ' / ' + mapping.source.stateId));
      body.append(el('span', mappingStatusLabel(project, mapping), 'mapping-status'));
      body.append(el('span', '来源：' + mapping.source.nodeIds.join('、'), 'relations-mapping-meta'));
      row.append(checkbox, body);
      list.append(row);
    }
    panel.append(list);
    const actions = el('div', undefined, 'relations-actions');
    actions.append(button('批量确认所选', () => setMappingsStatus('confirmed'), {disabled: !mappingSelection.size}));
    actions.append(button('批量排除所选', () => setMappingsStatus('excluded'), {disabled: !mappingSelection.size}));
    panel.append(actions);
    panel.append(el('p', '当前有效复用约束：' + project.mappings.filter(mapping => effectiveMapping(project, mapping)).length + ' 条（仅已确认且无未解决复核）', 'relations-help'));
    panel.append(el('p', '候选映射不是强制复用约束。', 'relations-note'));
    return panel;
  }

  // ---------- 关系概览 ----------
  function draftChip(project, draft, ui) {
    const role = roleOf(project, draft.id);
    const flags = [];
    if (ui.activeDraftId && ui.activeDraftId !== draft.id) {
      if (project.references.some(ref => ref.targetDraftId === ui.activeDraftId && ref.ownerDraftId === draft.id)) flags.push('使用方');
      if (project.references.some(ref => ref.ownerDraftId === ui.activeDraftId && ref.targetDraftId === draft.id)) flags.push('被引用');
    }
    const chip = el('button', undefined, 'draft-chip');
    chip.type = 'button';
    chip.dataset.draftId = draft.id;
    chip.setAttribute('aria-label', '组件：' + draft.name + '（' + role + (flags.length ? '，' + flags.join('，') : '') + '）');
    chip.setAttribute('aria-pressed', String(ui.activeDraftId === draft.id));
    if (ui.activeDraftId === draft.id) chip.classList.add('is-active');
    if (flags.length) chip.classList.add('is-related');
    chip.append(el('span', role, 'chip-role'), el('span', draft.name, 'chip-name'), el('span', '修订 ' + draft.revision, 'chip-meta'));
    for (const flag of flags) chip.append(el('span', flag, 'chip-flag'));
    chip.querySelector('.chip-role').dataset.role = role;
    chip.onclick = () => ctx.updateUI({activeDraftId: draft.id, tab: 'components', view: 'relations'});
    return chip;
  }
  function groupCluster(project, group, ui) {
    const cluster = el('section', undefined, 'relations-cluster is-group');
    cluster.setAttribute('role', 'group');
    cluster.setAttribute('aria-label', '组件组：' + group.name);
    const head = el('header', undefined, 'relations-cluster-head');
    const title = el('div', undefined, 'relations-cluster-title');
    title.append(el('h3', group.name), el('span', group.memberIds.length + ' 个组件', 'relations-cluster-meta'));
    head.append(title, button('并排预览', () => {
      preview = {kind: 'group', ids: groupMembers(group)};
      render();
    }, {label: '并排预览组件组：' + group.name, className: 'cluster-action'}));
    const members = el('div', undefined, 'relations-members');
    for (const id of groupMembers(group)) {
      const draft = draftById(project, id);
      if (draft) members.append(draftChip(project, draft, ui));
    }
    cluster.append(head, members);
    return cluster;
  }
  function looseCluster(project, ui) {
    const cluster = el('section', undefined, 'relations-cluster is-loose');
    cluster.setAttribute('role', 'group');
    cluster.setAttribute('aria-label', '独立组件');
    const head = el('header', undefined, 'relations-cluster-head');
    const title = el('div', undefined, 'relations-cluster-title');
    title.append(el('h3', '独立组件'), el('span', '同外观也可保持独立', 'relations-cluster-meta'));
    head.append(title);
    const members = el('div', undefined, 'relations-members');
    for (const draft of project.drafts.filter(item => !groupOf(project, item.id))) members.append(draftChip(project, draft, ui));
    if (!members.childElementCount) members.append(el('p', '没有独立组件。', 'relations-note'));
    cluster.append(head, members);
    return cluster;
  }
  function renderOverview(project, ui) {
    const wrapper = el('div', undefined, 'relations-overview');
    const head = el('header', undefined, 'relations-head');
    const copy = el('div', undefined, 'relations-heading');
    copy.append(el('h2', '组件关系概览'), el('p', '组件组表达同一组件的不同变体；箭头表示显式的嵌套引用。所有关系来自项目资料，不从画面反推。', 'relations-help'));
    const legend = el('div', undefined, 'relations-legend');
    for (const [key, text] of [['primary', '主体'], ['variant', '变体'], ['reference', '引用']]) {
      const item = el('span', text, 'legend-item');
      item.dataset.kind = key;
      legend.append(item);
    }
    head.append(copy, legend);
    const board = el('div', undefined, 'relations-board');
    // 每条引用独占一条右侧通道；按引用数量预留标签宽度，避免多引用时标签挤成一团。
    if (project.references.length) {
      board.style.paddingRight = Math.max(138, 26 + 18 * (project.references.length - 1) + 42) + 'px';
    }
    for (const group of project.groups) board.append(groupCluster(project, group, ui));
    if (project.drafts.some(draft => !groupOf(project, draft.id))) board.append(looseCluster(project, ui));
    if (!project.groups.length && !project.drafts.some(draft => !groupOf(project, draft.id))) board.append(el('p', '暂无组件稿。', 'relations-note'));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'relations-links');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', '组件引用连线');
    board.append(svg);
    wrapper.append(head, board);
    if (!project.references.length) wrapper.append(el('p', '尚无嵌套引用。重叠选区不会自动建立引用。', 'relations-note'));
    else wrapper.append(el('p', '已建立 ' + project.references.length + ' 条嵌套引用。选中组件可查看引用它的使用方。', 'relations-note'));
    return wrapper;
  }

  // 连线由项目 references 决定，位置只来自当前布局测量。
  function drawLinks() {
    if (!ctx) return;
    const project = ctx.getProject(), ui = ctx.getUI();
    if (ui.tab !== 'components' || ui.view !== 'relations' || preview) return;
    const board = ctx.slots.center.querySelector('.relations-board');
    const svg = ctx.slots.center.querySelector('.relations-links');
    if (!board || !svg || !project.references.length) return;
    const base = board.getBoundingClientRect();
    svg.setAttribute('viewBox', '0 0 ' + base.width + ' ' + base.height);
    svg.setAttribute('width', base.width);
    svg.setAttribute('height', base.height);
    svg.replaceChildren();
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    for (const [name, value] of [['id', 'relations-arrow'], ['viewBox', '0 0 10 10'], ['refX', '9'], ['refY', '5'], ['markerWidth', '7'], ['markerHeight', '7'], ['orient', 'auto-start-reverse']]) marker.setAttribute(name, value);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M0 0L10 5L0 10z');
    arrow.setAttribute('fill', 'currentColor');
    marker.append(arrow);
    defs.append(marker);
    svg.append(defs);
    const laneBase = 26, laneGap = 18;
    const placedLabels = [];
    const overlap = (one, two) => Math.min(one.right, two.right) - Math.max(one.left, two.left) > 0.5
      && Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) > 0.5;
    // 标签按 14px 行高在通道内纵向避让，绝不互相压字；仍在连线区域内才可见。
    function placeLabel(x, baseline, anchor) {
      const candidates = [0, -16, 16, -32, 32, -48, 48, -64, 64, -80, 80];
      for (const offset of candidates) {
        const y = baseline + offset;
        if (y - 11 < 2 || y + 3 > base.height - 2) continue;
        const rect = anchor === 'middle' ? {left: x - 13, right: x + 13, top: y - 11, bottom: y + 3}
          : {left: x - 1, right: x + 24, top: y - 11, bottom: y + 3};
        if (!placedLabels.some(item => overlap(item, rect))) { placedLabels.push(rect); return y; }
      }
      return null;
    }
    for (let index = 0; index < project.references.length; index++) {
      const ref = project.references[index];
      const owner = board.querySelector('[data-draft-id="' + CSS.escape(ref.ownerDraftId) + '"]');
      const target = board.querySelector('[data-draft-id="' + CSS.escape(ref.targetDraftId) + '"]');
      if (!owner || !target) continue;
      const from = owner.getBoundingClientRect(), to = target.getBoundingClientRect();
      const outgoing = project.references.filter(item => item.ownerDraftId === ref.ownerDraftId);
      const incoming = project.references.filter(item => item.targetDraftId === ref.targetDraftId);
      // 同一使用方的多条引用、同一被引用组件的多个使用方都错开锚点，避免箭头堆在同一点上。
      const clampAnchor = (value, height) => Math.max(-(height / 2 - 4), Math.min(height / 2 - 4, value));
      const sy = from.top + from.height / 2 - base.top
        + clampAnchor((outgoing.indexOf(ref) - (outgoing.length - 1) / 2) * 8, from.height);
      const ty = to.top + to.height / 2 - base.top
        + clampAnchor((incoming.indexOf(ref) - (incoming.length - 1) / 2) * 10, to.height);
      const fromRight = from.right - base.left, toLeft = to.left - base.left, toRight = to.right - base.left;
      let d, labelX, labelY, anchor;
      if (toLeft > fromRight + 30) {
        // 目标在右侧：从使用方右缘直达目标左缘，标签放在两卡片之间的空隙上方。
        const gap = Math.max(24, (toLeft - fromRight) * 0.5);
        d = 'M ' + fromRight + ' ' + sy + ' C ' + (fromRight + gap) + ' ' + sy + ', ' + (toLeft - gap) + ' ' + ty + ', ' + toLeft + ' ' + ty;
        labelX = Math.max(16, Math.min(base.width - 16, (fromRight + toLeft) / 2));
        labelY = Math.max(16, Math.min(from.top, to.top) - base.top - 6);
        anchor = 'middle';
      } else {
        // 垂直堆叠时每条引用使用独立的右侧通道，形成可逐条追踪的独立竖线。
        const lane = fromRight + laneBase + index * laneGap;
        const rise = Math.abs(ty - sy), radius = Math.min(8, rise / 2);
        const direction = ty >= sy ? 1 : -1;
        if (radius >= 2) {
          d = 'M ' + fromRight + ' ' + sy
            + ' L ' + (lane - radius) + ' ' + sy
            + ' Q ' + lane + ' ' + sy + ' ' + lane + ' ' + (sy + direction * radius)
            + ' L ' + lane + ' ' + (ty - direction * radius)
            + ' Q ' + lane + ' ' + ty + ' ' + (lane - radius) + ' ' + ty
            + ' L ' + toRight + ' ' + ty;
        } else {
          d = 'M ' + fromRight + ' ' + sy + ' C ' + lane + ' ' + sy + ', ' + lane + ' ' + ty + ', ' + toRight + ' ' + ty;
        }
        // 标签紧贴各自的竖线，并按行位避让；文字左对齐可读性高于居中小字。
        labelX = lane + 5;
        labelY = (sy + ty) / 2 + 4;
        anchor = 'start';
      }
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'relations-link');
      group.dataset.refId = ref.id;
      group.dataset.owner = ref.ownerDraftId;
      group.dataset.target = ref.targetDraftId;
      // 没有选中组件时不存在“相关/无关”，所有线保持正常可读，而不是被整体弱化。
      if (ui.activeDraftId) {
        group.dataset.related = String(ref.ownerDraftId === ui.activeDraftId || ref.targetDraftId === ui.activeDraftId);
      }
      group.setAttribute('role', 'img');
      group.setAttribute('aria-label', '引用：' + draftName(project, ref.ownerDraftId) + ' → ' + draftName(project, ref.targetDraftId));
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('marker-end', 'url(#relations-arrow)');
      path.setAttribute('fill', 'none');
      const textY = placeLabel(labelX, labelY, anchor);
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', labelX);
      label.setAttribute('y', textY === null ? labelY : textY);
      label.setAttribute('text-anchor', anchor);
      label.textContent = '引用';
      group.append(path, label);
      svg.append(group);
    }
  }

  // ---------- 预览 ----------
  function renderPreview(project) {
    const ids = preview.ids.filter(id => draftById(project, id));
    if (!ids.length) { preview = null; return renderOverview(project, ctx.getUI()); }
    const wrapper = el('div', undefined, 'relations-preview');
    const head = el('header', undefined, 'relations-preview-head');
    const actions = el('div', undefined, 'relations-preview-actions');
    actions.append(WorkbenchCommon.createZoomToolbar(previewScale, scale => { previewScale = scale; render(); }), button('返回关系概览', () => { preview = null; render(); }));
    head.append(el('h2', preview.kind === 'group' ? '同组并排预览' : '独立预览'), actions);
    const grid = el('div', undefined, 'relations-preview-grid');
    for (const id of ids) {
      const draft = draftById(project, id);
      const figure = el('figure', undefined, 'relations-preview-card');
      const caption = document.createElement('figcaption');
      caption.append(el('strong', roleOf(project, id) + ' · ' + draft.name));
      caption.append(el('span', '修订 ' + draft.revision + ' · ' + draft.content.width + ' × ' + draft.content.height, 'relations-preview-meta'));
      figure.append(caption);
      figure.append(WorkbenchCommon.createScaledDraftFrame(draft, previewScale).viewport);
      grid.append(figure);
    }
    wrapper.append(head, grid);
    return wrapper;
  }

  // ---------- 左侧与右侧 ----------
  function impactPanel() {
    const impact = el('section', undefined, 'relations-impact');
    impact.setAttribute('aria-label', '引用更新影响');
    impact.append(el('h2', pendingImpactPlan.heading || '引用更新影响'));
    impact.append(el('p', pendingImpactPlan.intro || ('共享组件“' + pendingImpactPlan.targetName + '”更新为修订 ' + pendingImpactPlan.newRevision + '；' + pendingImpactPlan.owners.length + ' 个使用方的共享结构将同步，以下覆盖会保留：'), 'relations-help'));
    const list = el('ul', undefined, 'relations-impact-list');
    for (const owner of pendingImpactPlan.owners) {
      if (!owner.refs.length) {
        list.append(el('li', owner.name + ' · 间接使用方'));
        continue;
      }
      for (const ref of owner.refs) {
        const overrides = ref.overrides.map(override => override.nodeId + '=' + override.value).join('；');
        list.append(el('li', owner.name + ' · 位置 ' + ref.slotNodeId + ' · 覆盖：' + (overrides || '无')));
      }
    }
    impact.append(list);
    const actions = el('div', undefined, 'relations-actions');
    actions.append(button(pendingImpactPlan.confirmLabel || '确认更新并同步', () => resolveImpact(true)), button(pendingImpactPlan.cancelLabel || '取消更新', () => resolveImpact(false)));
    impact.append(actions);
    impact.append(el('p', '取消、确认期间项目变化或覆盖无法安全保留时，不会提交任何修改。', 'relations-note'));
    return impact;
  }
  function renderLeft(project, ui) {
    const left = ctx.slots.left;
    const grouping = project.drafts.length > 0 && ui.tab === 'components';
    const mappings = project.prototype && project.drafts.length > 0 && (ui.tab === 'components' || ui.mode === 'edit');
    left.hidden = !(pendingImpactPlan || grouping || mappings);
    left.replaceChildren();
    if (left.hidden) return;
    if (pendingImpactPlan) left.append(impactPanel());
    if (grouping) left.append(groupingPanel(project, ui));
    if (mappings) left.append(mappingPanel(project, ui));
  }
  function groupingPanel(project, ui) {
    const panel = el('section', undefined, 'relations-panel');
    panel.append(el('h3', '组件组'));
    panel.append(el('p', '按组件列表中的实际勾选顺序定义；第一项为主体，其余为变体。', 'relations-help'));
    const label = el('label', '组件组名称', 'relations-field');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = groupName;
    input.placeholder = '例如：家园卡片组';
    input.oninput = () => { groupName = input.value; };
    label.append(input);
    panel.append(label);
    const actions = el('div', undefined, 'relations-actions');
    actions.append(button('定义组件组', defineGroup, {disabled: ui.selectedDraftIds.length < 2}));
    const currentGroup = selectedGroup(project, ui) || groupOf(project, ui.activeDraftId);
    actions.append(button('解散组件组', dissolveGroup, {disabled: !currentGroup}));
    panel.append(actions);
    panel.append(el('p', '调整组件组不会解除嵌套引用；引用是独立的人工决定。', 'relations-note'));
    return panel;
  }
  function renderReferenceSection(project, active, panel) {
    panel.append(el('h3', '嵌套引用'));
    const outgoing = project.references.filter(ref => ref.ownerDraftId === active.id);
    if (outgoing.length) {
      const list = el('div', undefined, 'relations-ref-list');
      for (const ref of outgoing) {
        const item = el('div', undefined, 'relations-ref');
        item.append(el('p', '使用「' + draftName(project, ref.targetDraftId) + '」 · 位置 ' + ref.slotNodeId + ' · 共享结构修订 ' + ref.targetRevision, 'relations-help'));
        if (ref.overrides.length) item.append(el('p', '覆盖：' + ref.overrides.map(override => override.nodeId + '=' + override.value).join('；'), 'relations-help'));
        item.append(button('删除引用：' + active.name + ' → ' + draftName(project, ref.targetDraftId), () => deleteReference(ref.id), {className: 'relations-danger'}));
        list.append(item);
      }
      panel.append(list);
    } else {
      panel.append(el('p', '该组件尚未引用其他组件。','relations-help'));
    }
    const incoming = project.references.filter(ref => ref.targetDraftId === active.id);
    if (incoming.length) {
      panel.append(el('h3', '引用此组件的使用方'));
      const list = el('div', undefined, 'relations-ref-list');
      for (const ref of incoming) {
        const detail = ref.overrides.length ? ' · 覆盖 ' + ref.overrides.map(override => override.nodeId + '=' + override.value).join('；') : '';
        list.append(el('p', draftName(project, ref.ownerDraftId) + ' · 位置 ' + ref.slotNodeId + detail, 'relations-help'));
      }
      panel.append(list);
    }
    const targets = project.drafts;
    const select = document.createElement('select');
    select.setAttribute('aria-label', '被引用组件');
    for (const draft of targets) {
      const option = document.createElement('option');
      option.value = draft.id;
      option.textContent = draft.name;
      option.selected = draft.id === referenceFormTargetId;
      select.append(option);
    }
    select.onchange = () => { referenceFormTargetId = select.value; referenceFormSignature = null; render(); };
    const targetLabel = el('label', '被引用组件', 'relations-field');
    targetLabel.append(select);
    panel.append(targetLabel);
    const slots = slotCandidates(project, active);
    if (!slots.length) {
      panel.append(el('p', '该组件没有可用的稳定引用位置。', 'relations-help'));
      return;
    }
    const slotSelect = document.createElement('select');
    slotSelect.setAttribute('aria-label', '引用位置');
    for (const slot of slots) {
      const option = document.createElement('option');
      option.value = slot.id;
      option.textContent = slot.id + '（' + slot.tag + '）';
      option.selected = slot.id === referenceFormSlotId;
      slotSelect.append(option);
    }
    slotSelect.onchange = () => { referenceFormSlotId = slotSelect.value; render(); };
    const slotLabel = el('label', '引用位置', 'relations-field');
    slotLabel.append(slotSelect);
    panel.append(slotLabel);
    const target = draftById(project, referenceFormTargetId);
    if (target) {
      const nodes = textOnlyNodes(target.content.html).slice(0, 24);
      if (nodes.length) {
        panel.append(el('p', '该位置的内容覆盖（与共享结构相同则不记录；留空会移除文字）：', 'relations-help'));
        for (const node of nodes) {
          const label = el('label', '覆盖文字：' + node.id, 'relations-field');
          const input = document.createElement('input');
          input.type = 'text';
          input.value = overrideValues.has(node.id) ? overrideValues.get(node.id) : node.text;
          input.oninput = () => overrideValues.set(node.id, input.value);
          label.append(input);
          panel.append(label);
        }
      }
    }
    panel.append(button('建立嵌套引用', createReference, {disabled: !referenceFormSlotId || !referenceFormTargetId}));
    panel.append(el('p', '重叠选区不会自动建立引用；引用必须显式建立，且不能指向自身或形成循环。', 'relations-note'));
  }
  function renderRight(project, ui) {
    const right = ctx.slots.right;
    const components = project.drafts.length > 0 && ui.tab === 'components';
    right.hidden = !components;
    right.replaceChildren();
    if (right.hidden) return;
    const panel = el('section', undefined, 'relations-panel');
    panel.append(el('h3', '当前组件'));
    const active = draftById(project, ui.activeDraftId);
    if (!active) {
      panel.append(el('p', '点击概览中的组件查看预览或建立嵌套引用。', 'relations-help'));
      right.append(panel);
      return;
    }
    const group = groupOf(project, active.id);
    panel.append(el('p', active.name + ' · ' + roleOf(project, active.id), 'relations-help'));
    const actions = el('div', undefined, 'relations-actions');
    actions.append(button('独立预览：' + active.name, () => { preview = {kind: 'single', ids: [active.id]}; render(); }));
    if (group) actions.append(button('同组并排预览', () => { preview = {kind: 'group', ids: groupMembers(group)}; render(); }, {label: '并排预览组件组：' + group.name}));
    panel.append(actions);
    ensureForm(project, active);
    renderReferenceSection(project, active, panel);
    right.append(panel);
  }

  function render() {
    if (!ctx) return;
    const project = ctx.getProject(), ui = ctx.getUI();
    if (mappingProjectId !== project.id) {
      mappingProjectId = project.id;
      mappingSelection.clear();
      candidateDraftId = null;
    }
    renderLeft(project, ui);
    renderRight(project, ui);
    const center = ctx.slots.center;
    const visible = ui.tab === 'components' && ui.view === 'relations' && project.drafts.length > 0;
    center.hidden = !visible;
    center.replaceChildren();
    if (!visible) return;
    center.append(preview ? renderPreview(project) : renderOverview(project, ui));
    drawLinks();
  }

  Workbench.registerFeature({
    id: 'relations',
    mount(context) {
      ctx = context;
      ctx.registerGuard('draft:update', async payload => {
        const plan = planDraftUpdate(ctx.getProject(), payload.draftId, payload.nextDraft);
        if (!plan) return true;
        if (!plan.owners.length) return plan.apply;
        const confirmed = await confirmImpact(plan);
        return confirmed ? plan.apply : false;
      });
      ctx.registerGuard('reference:create', createReferenceGuard);
      window.addEventListener('resize', () => { if (ctx && !ctx.slots.center.hidden) drawLinks(); });
    },
    render
  });
})();
