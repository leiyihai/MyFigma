import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNineSliceComponent } from '../dist/figma.js';

function rectangle() {
  return {
    type: 'RECTANGLE', name: '', x: 0, y: 0, width: 0, height: 0, removed: false,
    fills: [], constraints: null, locked: false, parent: null,
    resize(width, height) { this.width = width; this.height = height; },
    remove() {
      this.removed = true;
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    }
  };
}

function oldChild(component, name, failAfterRemove = false) {
  return {
    type: 'RECTANGLE', name, removed: false, parent: component, failAfterRemove,
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.removed = true;
      if (this.failAfterRemove) throw new Error(`Simulated remove failure: ${this.name}`);
    }
  };
}

function componentWith(children) {
  const component = {
    type: 'COMPONENT', width: 160, height: 120, layoutMode: 'VERTICAL', removed: false,
    fills: [{ type: 'IMAGE', imageHash: 'image' }], children,
    resize(width, height) { this.width = width; this.height = height; },
    appendChild(child) {
      child.parent = this;
      child.removed = false;
      this.children.push(child);
    },
    remove() { this.removed = true; }
  };
  for (const child of children) child.parent = component;
  return component;
}

function hostThatTracksRectangles() {
  const created = [];
  return {
    created,
    createRectangle() {
      const node = rectangle();
      created.push(node);
      return node;
    }
  };
}

const image = { width: 160, height: 120, fill: { type: 'IMAGE', imageHash: 'image' } };
const margins = { left: 16, top: 8, right: 8, bottom: 8 };

test('append failure removes every prepared slice and leaves the old child, fill, size and layout intact', () => {
  const host = hostThatTracksRectangles();
  const old = oldChild(undefined, '旧图片');
  const component = componentWith([old]);
  component.appendChild = () => { throw new Error('Simulated append failure'); };

  assert.throws(() => applyNineSliceComponent(host, component, image, margins), /append failure/);
  assert.deepEqual(component.children, [old]);
  assert.equal(old.removed, false);
  assert.deepEqual(component.fills, [{ type: 'IMAGE', imageHash: 'image' }]);
  assert.deepEqual([component.width, component.height], [160, 120]);
  assert.equal(component.layoutMode, 'VERTICAL');
  assert.equal(host.created.length, 9);
  assert.ok(host.created.every(node => node.removed), 'a failed append must not leave detached slices behind');
});

test('a failure while removing old children restores the ones already removed', () => {
  const host = hostThatTracksRectangles();
  const first = oldChild(undefined, '旧切片 1');
  const second = oldChild(undefined, '旧切片 2');
  const third = oldChild(undefined, '旧切片 3', true);
  const component = componentWith([first, second, third]);

  assert.throws(() => applyNineSliceComponent(host, component, image, margins), /remove failure/);
  assert.deepEqual(component.children.map(child => child.name).sort(),
    ['旧切片 1', '旧切片 2', '旧切片 3']);
  assert.ok(component.children.every(child => child.removed === false));
  assert.deepEqual(component.fills, [{ type: 'IMAGE', imageHash: 'image' }]);
  assert.deepEqual([component.width, component.height], [160, 120]);
  assert.equal(component.layoutMode, 'VERTICAL');
  assert.ok(host.created.every(node => node.removed), 'a failed removal rollback must not leave detached slices behind');
});
