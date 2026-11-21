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
  component.resize(plan.width, plan.height);
  component.fills = [];
  component.layoutMode = 'NONE';
  for (const child of [...component.children]) child.remove();
  for (const slice of plan.slices) {
    const rect = host.createRectangle();
    component.appendChild(rect);
    rect.name = `切片 ${slice.row + 1}-${slice.column + 1}`;
    rect.resize(slice.width, slice.height);
    rect.x = slice.x;
    rect.y = slice.y;
    rect.constraints = { horizontal: slice.horizontal, vertical: slice.vertical };
    rect.fills = [{
      ...image.fill, scaleMode: 'CROP',
      imageTransform: [[slice.width / plan.width, 0, slice.x / plan.width],
        [0, slice.height / plan.height, slice.y / plan.height]]
    }];
    rect.locked = true;
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
