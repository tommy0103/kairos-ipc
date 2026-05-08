import type { VNode, VNodeArrayChildren, VNodeProps } from 'vue';
import { Fragment } from 'vue';

export type Element = HTMLElement | SVGElement;

export const isElement = (el: any): el is Element => el?.nodeType === Node.ELEMENT_NODE;

export const useElementLifecycleVNodeHooks = (hooks: {
  mounted?: (el: Element) => void;
  updated?: (el: Element) => void;
  beforeUnmount?: (el: Element) => void;
}) => {
  const attachedHooksWeakSet = new WeakSet<Function>();
  const maybeAttachVNodeHook = <HookName extends keyof VNodeProps, HookFunction extends VNodeProps[HookName] & Function>(
    props: VNodeProps, hookName: HookName, hookFunction: HookFunction,
  ) => {
    let existing = props[hookName] as Function | Function[] | undefined;
    if (!existing) existing = [];
    else if (!Array.isArray(existing)) existing = [existing];

    if (existing.some(h => attachedHooksWeakSet.has(h))) return;
    attachedHooksWeakSet.add(hookFunction);
    existing.push(hookFunction);

    props[hookName] = existing as unknown as VNodeProps[HookName];
  };

  const mountedElements = new WeakSet<Element>();
  const triggerMounted = (element: any) => {
    if (!isElement(element)) return;
    if (mountedElements.has(element)) return;
    mountedElements.add(element);
    hooks.mounted?.(element);
  };
  const triggerUpdated = (element: any) => isElement(element) && hooks.updated?.(element);
  const triggerBeforeUnmount = (element: any) => {
    if (!isElement(element)) return;
    if (!mountedElements.delete(element)) return;
    hooks.beforeUnmount?.(element);
  };

  const attachVNodeHooks = (vNode: VNode) => {
    if (vNode.type === Fragment && Array.isArray(vNode.children)) attachVNodeHooksToChildren(vNode.children);
    else if (typeof vNode.type === 'string') {
      const props = vNode.props ??= {};
      maybeAttachVNodeHook(props, 'onVnodeMounted', target => target === vNode && triggerMounted(target.el));
      maybeAttachVNodeHook(props, 'onVnodeUpdated', target => target === vNode && triggerUpdated(target.el));
      maybeAttachVNodeHook(props, 'onVnodeBeforeUnmount', target => target === vNode && triggerBeforeUnmount(target.el));
      triggerMounted(vNode.el);
    } else {
      // Component
      const props = vNode.props ??= {};
      maybeAttachVNodeHook(props, 'onVnodeMounted', target => target === vNode && attachVNodeHooksToSubTree(vNode));
      maybeAttachVNodeHook(props, 'onVnodeUpdated', target => target === vNode && attachVNodeHooksToSubTree(vNode));
      attachVNodeHooksToSubTree(vNode);
    }
    return vNode;
  };

  const attachVNodeHooksToSubTree = (vNode: VNode) =>
    vNode.component?.subTree && attachVNodeHooks(vNode.component.subTree);

  const attachVNodeHooksToChildren = (children: VNodeArrayChildren) => {
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      else if (Array.isArray(child)) attachVNodeHooksToChildren(child);
      else attachVNodeHooks(child);
    }
  };

  return (vNode: VNode | VNode[] | null | undefined) => vNode && (Array.isArray(vNode) ? vNode.map(attachVNodeHooks) : attachVNodeHooks(vNode));
};
