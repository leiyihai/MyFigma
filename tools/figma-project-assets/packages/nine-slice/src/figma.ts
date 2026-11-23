import { createNineSlicePlan, type Margins, type Size } from './index.js';

/** Inject the Figma API at the platform boundary; this module has no global or plugin runtime dependency. */
export function applyNineSliceComponent(
  host: Pick<PluginAPI, 'createRectangle'>,
  component: ComponentNode,
  image: Size & { fill: ImagePaint },
  margins: Margins,
  options: { overlap?: boolean } = {}
): ComponentNode {
  const plan = createNineSlicePlan(image, margins, options.overlap);
  const prepared: Array<{ rect: RectangleNode; slice: (typeof plan.slices)[number] }> = [];
  try {
    // Prepare every rectangle before touching the existing component. A
    // creation failure must leave an existing 9-slice component intact.
    for (const slice of plan.slices) {
      const rect = host.createRectangle();
      prepared.push({ rect, slice });
      rect.name = `切片 ${slice.row + 1}-${slice.column + 1}`;
      rect.resize(slice.width, slice.height);
      rect.constraints = { horizontal: slice.horizontal, vertical: slice.vertical };
      rect.fills = [{
        ...image.fill, scaleMode: 'CROP',
        imageTransform: [[slice.width / plan.width, 0, slice.x / plan.width],
          [0, slice.height / plan.height, slice.y / plan.height]]
      }];
      rect.locked = true;
    }
  } catch (error) {
    for (const { rect } of prepared) rect.remove();
    throw error;
  }

  const previousChildren = [...component.children];
  const previous = {
    width: component.width,
    height: component.height,
    fills: Array.isArray(component.fills) ? [...component.fills] : [],
    layoutMode: component.layoutMode
  };
  const appended: RectangleNode[] = [];
  try {
    component.resize(plan.width, plan.height);
    component.fills = [];
    component.layoutMode = 'NONE';
    for (const { rect, slice } of prepared) {
      component.appendChild(rect);
      appended.push(rect);
      rect.x = slice.x;
      rect.y = slice.y;
    }
    for (const child of previousChildren) child.remove();
  } catch (error) {
    for (const rect of appended) rect.remove();
    // A failed upgrade must not leave the component half converted: restore
    // the previous fill, size and layout so the source image stays usable.
    try {
      component.fills = previous.fills;
      component.layoutMode = previous.layoutMode;
      component.resize(previous.width, previous.height);
    } catch { /* rollback is best effort; never hide the original failure */ }
    throw error;
  }
  return component;
}

export function createNineSliceComponent(
  host: Pick<PluginAPI, 'createComponent' | 'createRectangle'>,
  image: Size & { fill: ImagePaint },
  margins: Margins,
  options: { overlap?: boolean } = {}
): ComponentNode {
  const component = host.createComponent();
  try {
    return applyNineSliceComponent(host, component, image, margins, options);
  } catch (error) {
    component.remove();
    throw error;
  }
}
