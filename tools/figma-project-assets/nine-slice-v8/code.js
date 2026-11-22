"use strict";
(() => {
  // ../packages/nine-slice/src/index.ts
  function createNineSlicePlan(size, margins, overlap = false) {
    const { width, height } = size;
    if (![width, height].every((value) => Number.isFinite(value) && value > 0) || ![margins.left, margins.top, margins.right, margins.bottom].every((value) => Number.isFinite(value) && value >= 0) || margins.left + margins.right >= width || margins.top + margins.bottom >= height) {
      throw new RangeError("\u8FB9\u8DDD\u5FC5\u987B\u4E3A\u6709\u9650\u975E\u8D1F\u6570\uFF0C\u4E14\u5DE6\u53F3\u4E4B\u548C\u5C0F\u4E8E\u5BBD\u5EA6\u3001\u4E0A\u4E0B\u4E4B\u548C\u5C0F\u4E8E\u9AD8\u5EA6\uFF1B\u56FE\u7247\u5C3A\u5BF8\u5FC5\u987B\u4E3A\u6709\u9650\u6B63\u6570\u3002");
    }
    const columns = [margins.left, width - margins.left - margins.right, margins.right];
    const rows = [margins.top, height - margins.top - margins.bottom, margins.bottom];
    const xs = [0, margins.left, width - margins.right];
    const ys = [0, margins.top, height - margins.bottom];
    const constraints = ["MIN", "STRETCH", "MAX"];
    const slices = [];
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        if (columns[column] === 0 || rows[row] === 0) continue;
        let x = xs[column], sliceWidth = columns[column], sliceHeight = rows[row];
        if (overlap) {
          if (column < 2) sliceWidth += 1;
          if (row < 2) sliceHeight += 1;
          if (column > 0) {
            x -= 0.5;
            sliceWidth += 0.5;
          }
        }
        slices.push({
          x,
          y: ys[row],
          width: sliceWidth,
          height: sliceHeight,
          row,
          column,
          horizontal: constraints[column],
          vertical: constraints[row]
        });
      }
    }
    return { width, height, slices };
  }

  // ../packages/nine-slice/src/figma.ts
  function applyNineSliceComponent(host, component, image, margins, options = {}) {
    const plan = createNineSlicePlan(image, margins, options.overlap);
    const prepared = [];
    try {
      for (const slice of plan.slices) {
        const rect = host.createRectangle();
        prepared.push({ rect, slice });
        rect.name = `\u5207\u7247 ${slice.row + 1}-${slice.column + 1}`;
        rect.resize(slice.width, slice.height);
        rect.constraints = { horizontal: slice.horizontal, vertical: slice.vertical };
        rect.fills = [{
          ...image.fill,
          scaleMode: "CROP",
          imageTransform: [
            [slice.width / plan.width, 0, slice.x / plan.width],
            [0, slice.height / plan.height, slice.y / plan.height]
          ]
        }];
        rect.locked = true;
      }
    } catch (error) {
      for (const { rect } of prepared) rect.remove();
      throw error;
    }
    const previous = [...component.children];
    const appended = [];
    try {
      component.resize(plan.width, plan.height);
      component.fills = [];
      component.layoutMode = "NONE";
      for (const { rect, slice } of prepared) {
        component.appendChild(rect);
        appended.push(rect);
        rect.x = slice.x;
        rect.y = slice.y;
      }
      for (const child of previous) child.remove();
    } catch (error) {
      for (const rect of appended) rect.remove();
      throw error;
    }
    return component;
  }
  function createNineSliceComponent(host, image, margins, options = {}) {
    const component = host.createComponent();
    try {
      return applyNineSliceComponent(host, component, image, margins, options);
    } catch (error) {
      component.remove();
      throw error;
    }
  }

  // ../packages/nine-slice/src/record.ts
  var NINE_SLICE_RECORD_KEY = "myfigma.nineSlice.v1";
  var NINE_SLICE_SHARED_NAMESPACE = "myfigma";
  var NINE_SLICE_SHARED_KEY = "nineSlice.v1";
  function readNineSliceRecord(node) {
    return node.getSharedPluginData?.(NINE_SLICE_SHARED_NAMESPACE, NINE_SLICE_SHARED_KEY) || node.getPluginData(NINE_SLICE_RECORD_KEY);
  }
  function writeNineSliceRecord(node, value) {
    if (node.setSharedPluginData) node.setSharedPluginData(NINE_SLICE_SHARED_NAMESPACE, NINE_SLICE_SHARED_KEY, value);
    node.setPluginData(NINE_SLICE_RECORD_KEY, value);
  }
  function validMargins(value) {
    if (!value || typeof value !== "object") return false;
    const margins = value;
    return [margins.left, margins.top, margins.right, margins.bottom].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
  }
  function validSize(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1e6;
  }
  function parseNineSliceRecord(raw) {
    if (!raw) return void 0;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return void 0;
    }
    if (!value || typeof value !== "object") return void 0;
    const record = value;
    if (record.schemaVersion !== 1 || !validMargins(record.margins) || typeof record.overlap !== "boolean" || !validSize(record.width) || !validSize(record.height)) return void 0;
    const project = validMargins(record.project) ? record.project : void 0;
    const current = validMargins(record.current) ? record.current : record.margins;
    const override = typeof record.override === "boolean" ? record.override : project === void 0;
    return {
      schemaVersion: 1,
      margins: current,
      overlap: record.overlap,
      width: record.width,
      height: record.height,
      project,
      current,
      override
    };
  }
  function createNineSliceRecord(current, size, options = {}) {
    return {
      schemaVersion: 1,
      margins: current,
      overlap: options.overlap === true,
      width: size.width,
      height: size.height,
      ...options.project === void 0 ? {} : { project: options.project },
      current,
      override: options.override === true
    };
  }
  function serializeNineSliceRecord(record) {
    return JSON.stringify(record);
  }

  // code.ts
  figma.showUI(__html__, { width: 360, height: 740, themeColors: true });
  var currentLang = "en";
  var defaults = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    all: 0,
    overlap: false,
    keepOriginal: false,
    batchMode: false,
    lang: "auto",
    settingsVersion: 2
  };
  var notifications = {
    zh: { no_img: "\u274C \u8BF7\u5728\u753B\u5E03\u9009\u4E2D\u56FE\u7247\u56FE\u5C42", success: "\u2705 \u4E5D\u5BAB\u683C\u7EC4\u4EF6\u5DF2\u751F\u6210" },
    en: { no_img: "\u274C Please select at least one image layer", success: "\u2705 9-Slice Component Generated" },
    ja: { no_img: "\u274C \u753B\u50CF\u30EC\u30A4\u30E4\u30FC\u3092\u9078\u629E\u3057\u3066\u304F\u3060\u3055\u3044", success: "\u2705 \u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u4F5C\u6210\u5B8C\u4E86" },
    ko: { no_img: "\u274C \uC774\uBBF8\uC9C0 \uB808\uC774\uC5B4\uB97C \uC120\uD0DD\uD558\uC138\uC694", success: "\u2705 \uAD6C\uC131 \uC694\uC18C \uC0DD\uC131 \uC644\uB8CC" },
    ru: { no_img: "\u274C \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043B\u043E\u0439 \u0441 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435\u043C", success: "\u2705 \u041A\u043E\u043C\u043F\u043E\u043D\u0435\u043D\u0442 \u0441\u043E\u0437\u0434\u0430\u043D" },
    de: { no_img: "\u274C Bildebene ausw\xE4hlen", success: "\u2705 Komponente erstellt" },
    fr: { no_img: "\u274C S\xE9lectionnez un calque image", success: "\u2705 Composant g\xE9n\xE9r\xE9" }
  };
  function notify(key) {
    figma.notify(notifications[currentLang][key]);
  }
  function notifyLocalized(zh, en, options) {
    figma.notify(currentLang === "zh" ? zh : en, options);
  }
  function sameMargins(left, right) {
    if (!left || !right) return left === right;
    return left.left === right.left && left.top === right.top && left.right === right.right && left.bottom === right.bottom;
  }
  function isLanguage(value) {
    return Object.prototype.hasOwnProperty.call(notifications, value);
  }
  function isImageNode(node) {
    return "fills" in node && Array.isArray(node.fills) && node.fills.some((fill) => fill.type === "IMAGE");
  }
  function isConvertibleImageNode(node) {
    return node.type !== "INSTANCE" && node.type !== "COMPONENT" && isImageNode(node);
  }
  function imageFill(node) {
    return Array.isArray(node.fills) ? node.fills.find((fill) => fill.type === "IMAGE") : void 0;
  }
  function isSliceNode(node) {
    return node.type === "RECTANGLE" && /^切片 [1-3]-[1-3]$/.test(node.name);
  }
  function deriveSlice(component) {
    const byName = new Map(component.children.filter(isSliceNode).map((node) => [node.name, node]));
    const children = [...byName.values()];
    const overlap = children.some((child) => !Number.isInteger(child.x) || !Number.isInteger(child.y));
    const centerX = byName.get("\u5207\u7247 1-2");
    const centerY = byName.get("\u5207\u7247 2-1");
    const right = byName.get("\u5207\u7247 1-3");
    const bottom = byName.get("\u5207\u7247 3-1");
    return {
      overlap,
      margins: {
        left: centerX ? centerX.x + (overlap ? 0.5 : 0) : 0,
        top: centerY?.y ?? 0,
        right: right ? right.width - (overlap ? 0.5 : 0) : 0,
        bottom: bottom?.height ?? 0
      }
    };
  }
  function savedMargins(component) {
    return parseNineSliceRecord(readNineSliceRecord(component));
  }
  function findEditable(node) {
    if (!node) return null;
    const component = node.type === "COMPONENT" ? node : null;
    if (!component || !component.children.length || !component.children.every(isSliceNode)) return null;
    const fills = component.children.map((child) => imageFill(child)).filter((fill) => !!fill);
    if (!fills.length || new Set(fills.map((fill) => fill.imageHash)).size !== 1) return null;
    const saved = savedMargins(component);
    const derived = deriveSlice(component);
    let margins = saved?.current ?? derived.margins;
    let overlap = saved?.overlap ?? derived.overlap;
    try {
      createNineSlicePlan(component, margins, overlap);
    } catch {
      if (!saved) return null;
      margins = derived.margins;
      overlap = derived.overlap;
      try {
        createNineSlicePlan(component, margins, overlap);
      } catch {
        return null;
      }
    }
    return {
      component,
      margins,
      overlap,
      fill: fills[0],
      width: component.width,
      height: component.height,
      target: "component",
      record: saved,
      legacy: !saved
    };
  }
  function rememberSlice(component, margins, overlap, override) {
    try {
      const existing = savedMargins(component);
      const record = createNineSliceRecord(
        margins,
        { width: component.width, height: component.height },
        { project: existing?.project, overlap, override }
      );
      writeNineSliceRecord(component, serializeNineSliceRecord(record));
    } catch (error) {
      console.error("\u4FDD\u5B58\u4E5D\u5BAB\u683C\u4FE1\u606F\u5931\u8D25", error);
    }
  }
  function editPayload(edit, editable) {
    return {
      margins: edit.margins,
      overlap: edit.overlap,
      target: edit.target,
      name: edit.component.name,
      editable,
      legacy: edit.legacy,
      project: edit.record?.project,
      override: edit.record?.override ?? true
    };
  }
  var previewVersion = 0;
  async function sendSelectionToUI() {
    const version = ++previewVersion;
    try {
      await figma.currentPage.loadAsync();
    } catch (error) {
      console.error("\u52A0\u8F7D\u5F53\u524D\u9875\u5931\u8D25", error);
    }
    if (version !== previewVersion) return;
    const node = figma.currentPage.selection[0];
    const edit = findEditable(node);
    let instanceComponent = null;
    if (node?.type === "INSTANCE") {
      try {
        instanceComponent = await node.getMainComponentAsync();
      } catch (error) {
        console.error("\u8BFB\u53D6\u5B9E\u4F8B\u4E3B\u7EC4\u4EF6\u5931\u8D25", error);
      }
    }
    if (version !== previewVersion) return;
    const instanceEdit = instanceComponent ? findEditable(instanceComponent) : null;
    const view = edit ?? instanceEdit;
    const payload = edit ? editPayload(edit, true) : instanceEdit ? editPayload(instanceEdit, false) : null;
    const unsupported = payload || !node ? null : node.type === "INSTANCE" ? "instance" : node.type === "COMPONENT" ? "component" : null;
    const fill = view?.fill ?? (node && isImageNode(node) ? imageFill(node) : void 0);
    const width = view?.width ?? (node && "width" in node ? node.width : 0);
    const height = view?.height ?? (node && "height" in node ? node.height : 0);
    try {
      const hash = fill?.imageHash;
      const image = hash ? figma.getImageByHash(hash) : null;
      if (image) {
        const bytes = await image.getBytesAsync();
        if (version === previewVersion) {
          figma.ui.postMessage({ type: "update-preview", bytes, width, height, edit: payload, unsupported });
        }
        return;
      }
    } catch (error) {
      console.error("\u8BFB\u53D6\u56FE\u7247\u9884\u89C8\u5931\u8D25", error);
    }
    if (version === previewVersion) figma.ui.postMessage({ type: "update-preview", bytes: null, edit: payload, unsupported });
  }
  async function initSettings() {
    let saved = {};
    try {
      saved = await figma.clientStorage.getAsync("nineSliceSettings") || {};
    } catch (error) {
      console.error("\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25", error);
    }
    const settings = { ...defaults, ...saved };
    if (saved.settingsVersion !== 2) {
      settings.overlap = false;
      settings.keepOriginal = false;
      settings.batchMode = false;
      settings.settingsVersion = 2;
    }
    if (isLanguage(settings.lang)) currentLang = settings.lang;
    figma.ui.postMessage({ type: "init-settings", settings });
  }
  figma.on("selectionchange", () => {
    void sendSelectionToUI();
  });
  void initSettings();
  void sendSelectionToUI();
  function validateMargins(msg, targets) {
    try {
      for (const node of targets) createNineSlicePlan(node, msg);
      return true;
    } catch {
      return false;
    }
  }
  function generate(source, msg) {
    const fill = imageFill(source);
    if (!fill) throw new Error("\u56FE\u7247\u586B\u5145\u4E0D\u5B58\u5728");
    const component = createNineSliceComponent(figma, { width: source.width, height: source.height, fill }, msg, { overlap: msg.overlap });
    try {
      const parent = source.parent;
      if (parent && "appendChild" in parent) parent.appendChild(component);
      component.name = source.name;
      component.x = msg.keepOriginal ? source.x + source.width + 50 : source.x;
      component.y = source.y;
      rememberSlice(component, { left: msg.left, top: msg.top, right: msg.right, bottom: msg.bottom }, msg.overlap, true);
      return component;
    } catch (error) {
      component.remove();
      throw error;
    }
  }
  var generating = false;
  async function restoreProject() {
    if (generating) return;
    const edit = findEditable(figma.currentPage.selection[0]);
    if (!edit) {
      notifyUnsupported();
      return;
    }
    const project = edit.record?.project;
    if (!project) {
      notifyLocalized(
        "\u8BE5\u7EC4\u4EF6\u6CA1\u6709\u8BB0\u5F55\u9879\u76EE\u53C2\u6570\uFF0C\u65E0\u6CD5\u6062\u590D\uFF1B\u672A\u505A\u4FEE\u6539\u3002",
        "This component has no recorded project parameter, so it cannot be restored. Nothing changed.",
        { error: true }
      );
      return;
    }
    try {
      createNineSlicePlan({ width: edit.width, height: edit.height }, project, edit.record?.overlap);
    } catch {
      notifyLocalized(
        "\u9879\u76EE\u53C2\u6570\u65E0\u6CD5\u5E94\u7528\u5230\u5F53\u524D\u7EC4\u4EF6\u5C3A\u5BF8\uFF0C\u672A\u505A\u4FEE\u6539\u3002",
        "The project parameter does not fit the current component size. Nothing changed.",
        { error: true }
      );
      return;
    }
    generating = true;
    try {
      applyNineSliceComponent(
        figma,
        edit.component,
        { width: edit.width, height: edit.height, fill: edit.fill },
        project,
        { overlap: edit.record?.overlap }
      );
      rememberSlice(edit.component, project, edit.record?.overlap === true, false);
      void sendSelectionToUI();
      notifyLocalized("\u5DF2\u6062\u590D\u9879\u76EE\u53C2\u6570\uFF0C\u5E76\u6E05\u9664\u624B\u52A8\u8FB9\u8DDD\u3002", "Project parameters restored; manual margins cleared.");
    } catch (error) {
      console.error("\u6062\u590D\u9879\u76EE\u53C2\u6570\u5931\u8D25", error);
      notifyLocalized("\u6062\u590D\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63D2\u4EF6\u63A7\u5236\u53F0\u3002", "Restore failed. Check the plugin console.", { error: true });
    } finally {
      generating = false;
    }
  }
  function notifyUnsupported() {
    notifyLocalized(
      "\u65E0\u6CD5\u8BC6\u522B\u8BE5\u7EC4\u4EF6\uFF1A\u8BF7\u9009\u62E9\u672C\u5DE5\u5177\u751F\u6210\u7684\u4E5D\u5BAB\u683C\u4E3B\u7EC4\u4EF6\u6216\u56FE\u7247\u56FE\u5C42\u3002\u672A\u505A\u4FEE\u6539\u3002",
      "Unrecognized component. Select a 9-slice main component created by this tool or an image layer. Nothing changed.",
      { error: true }
    );
  }
  figma.ui.onmessage = async (msg) => {
    if (msg?.type === "ui-ready") {
      void sendSelectionToUI();
      return;
    }
    if (msg?.type === "restore-project") {
      await restoreProject();
      return;
    }
    if (!msg || msg.type !== "save-only" && msg.type !== "generate") return;
    if (isLanguage(msg.lang)) currentLang = msg.lang;
    try {
      await figma.clientStorage.setAsync("nineSliceSettings", { ...msg, settingsVersion: 2 });
    } catch (error) {
      console.error("\u4FDD\u5B58\u8BBE\u7F6E\u5931\u8D25", error);
    }
    if (msg.type !== "generate" || generating) return;
    const edit = findEditable(figma.currentPage.selection[0]);
    if (edit) {
      try {
        createNineSlicePlan({ width: edit.width, height: edit.height }, msg, msg.overlap);
      } catch {
        figma.notify(currentLang === "zh" ? "\u8FB9\u8DDD\u5FC5\u987B\u4E3A\u975E\u8D1F\u6570\uFF0C\u4E14\u5DE6\u53F3\u4E4B\u548C\u5C0F\u4E8E\u5BBD\u5EA6\u3001\u4E0A\u4E0B\u4E4B\u548C\u5C0F\u4E8E\u9AD8\u5EA6\u3002" : "Margins must be non-negative; their sums must be smaller than the component width and height.", { error: true });
        return;
      }
      generating = true;
      try {
        const margins = { left: msg.left, top: msg.top, right: msg.right, bottom: msg.bottom };
        const unchanged = sameMargins(edit.record?.current ?? edit.margins, margins) && (edit.record?.overlap ?? edit.overlap) === msg.overlap;
        const override = edit.record && unchanged ? edit.record.override : true;
        applyNineSliceComponent(figma, edit.component, { width: edit.width, height: edit.height, fill: edit.fill }, msg, { overlap: msg.overlap });
        rememberSlice(edit.component, margins, msg.overlap, override);
        figma.viewport.scrollAndZoomIntoView([edit.component]);
        notify("success");
      } catch (error) {
        console.error("\u66F4\u65B0\u4E5D\u5BAB\u683C\u5931\u8D25", error);
        figma.notify(currentLang === "zh" ? "\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63D2\u4EF6\u63A7\u5236\u53F0\u3002" : "Update failed. Check the plugin console.", { error: true });
      } finally {
        generating = false;
      }
      return;
    }
    const targets = figma.currentPage.selection.filter(isConvertibleImageNode);
    if (targets.length === 0) {
      const first = figma.currentPage.selection[0];
      if (first?.type === "INSTANCE") {
        notifyLocalized(
          "\u9009\u4E2D\u7684\u662F\u5B9E\u4F8B\uFF1B\u8BF7\u5B9A\u4F4D\u4E3B\u7EC4\u4EF6\u540E\u7F16\u8F91\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u6539\u9020\u5B9E\u4F8B\u3002",
          "An instance is selected. Locate its main component to edit; instances are never converted automatically.",
          { error: true }
        );
      } else if (first?.type === "COMPONENT") {
        notifyUnsupported();
      } else notify("no_img");
      return;
    }
    const finalTargets = msg.batchMode ? targets : [targets[0]];
    if (!validateMargins(msg, finalTargets)) {
      figma.notify(currentLang === "zh" ? "\u8FB9\u8DDD\u5FC5\u987B\u4E3A\u975E\u8D1F\u6570\uFF0C\u4E14\u5DE6\u53F3\u4E4B\u548C\u5C0F\u4E8E\u5BBD\u5EA6\u3001\u4E0A\u4E0B\u4E4B\u548C\u5C0F\u4E8E\u9AD8\u5EA6\uFF08\u6279\u91CF\u65F6\u6BCF\u5F20\u56FE\u5747\u987B\u6EE1\u8DB3\uFF09\u3002" : "Margins must be non-negative; their sums must be smaller than every target\u2019s width and height.", { error: true });
      return;
    }
    generating = true;
    const generated = [];
    try {
      for (const source of finalTargets) generated.push(generate(source, msg));
      if (!msg.keepOriginal) finalTargets.forEach((source) => source.remove());
      figma.currentPage.selection = generated;
      figma.viewport.scrollAndZoomIntoView(generated);
      notify("success");
    } catch (error) {
      generated.forEach((node) => {
        if (!node.removed) node.remove();
      });
      console.error("\u751F\u6210\u5931\u8D25", error);
      figma.notify(currentLang === "zh" ? "\u751F\u6210\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63D2\u4EF6\u63A7\u5236\u53F0\u3002" : "Generation failed. Check the plugin console.", { error: true });
    } finally {
      generating = false;
    }
  };
})();
