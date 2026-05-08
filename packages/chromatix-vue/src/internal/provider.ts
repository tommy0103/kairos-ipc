import { useCurrentElement } from '@vueuse/core';
import type { DefineComponent, PropType } from 'vue';
import { computed, defineComponent, inject, provide, toValue, watch } from 'vue';

import type { ChromatixTheme } from '@kairos-ipc/chromatix';
import { ChromatixKey } from '../plugin';
import type { PaletteHueValuesInputPartial } from '../utils';
import { paletteHueValuesInputToCssVariables, paletteHueValuesInputToValues } from '../utils';
import { isElement, useElementLifecycleVNodeHooks, type Element } from './element-lifecycle';

const providePaletteHueInternal = <PaletteName extends string>(paletteHueValuesInput: PaletteHueValuesInputPartial<PaletteName>) => {
  const parentContext = inject(ChromatixKey);
  if (!parentContext) throw new Error('Failed to inject Chromatix context. `providePaletteHue` must be called within a Component context and `createChromatix()` plugin must be used globally.');
  provide(ChromatixKey, computed(() => ({
    ...parentContext.value,
    paletteHueValues: {
      ...parentContext.value.paletteHueValues ?? {},
      ...paletteHueValuesInputToValues(paletteHueValuesInput),
    },
  })));
  const elements = new Set<Element>();
  const cssVariables = computed(() => paletteHueValuesInputToCssVariables(parentContext.value.theme as ChromatixTheme<number, string, PaletteName>, paletteHueValuesInput));
  watch(cssVariables, (newValues, oldValues) => {
    const valuesToRemove = Object.keys(oldValues ?? {}).filter(key => !(key in newValues));
    for (const element of elements) {
      for (const key of valuesToRemove) element.style.removeProperty(key);
      for (const [key, value] of Object.entries(newValues)) element.style.setProperty(key, value);
    }
  }, { immediate: true, deep: true });
  return {
    onMounted: (element: Element) => {
      elements.add(element);
      for (const [key, value] of Object.entries(cssVariables.value)) element.style.setProperty(key, value);
    },
    onBeforeUnmount: (element: Element) => elements.delete(element), // No need to remove CSS variables here, removing could cause flickering
  };
};

/**
 * This could only be called in a Component with a single root DOM element. CSS variables will be applied to `useCurrentElement()`.
 */
export const providePaletteHue = <PaletteName extends string>(paletteHueValuesInput: PaletteHueValuesInputPartial<PaletteName>) => {
  const currentElement = useCurrentElement();
  const provider = providePaletteHueInternal(paletteHueValuesInput);
  watch(currentElement, (element, oldElement) => {
    if (isElement(element)) provider.onMounted(element);
    if (isElement(oldElement)) provider.onBeforeUnmount(oldElement);
  });
};

export const PaletteHueProvider = defineComponent({
  name: 'PaletteHueProvider',
  props: {
    values: {
      type: Object as PropType<PaletteHueValuesInputPartial<string> | undefined>,
    },
  },
  setup(props, { slots }) {
    const provider = providePaletteHueInternal(() => toValue(props.values) ?? {});
    const installVNodeHooks = useElementLifecycleVNodeHooks({
      mounted: element => provider.onMounted(element),
      beforeUnmount: element => provider.onBeforeUnmount(element),
    });
    return () => installVNodeHooks(slots.default?.());
  },
}) satisfies PaletteHueProvider<string>;

export type PaletteHueProvider<PaletteName extends string> = DefineComponent<{
  values: {
    type: PropType<PaletteHueValuesInputPartial<PaletteName> | undefined>;
    required: true;
  };
}>;
