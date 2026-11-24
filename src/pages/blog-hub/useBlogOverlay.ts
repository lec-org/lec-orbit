import { useLayoutEffect } from 'react';
import { useOrbitStore } from '@/stores/useOrbitStore';

export function useBlogOverlay(open: boolean): void {
  const pushOverlay = useOrbitStore((state) => state.pushOverlay);
  const popOverlay = useOrbitStore((state) => state.popOverlay);
  useLayoutEffect(() => {
    if (!open) return;
    pushOverlay();
    return popOverlay;
  }, [open, pushOverlay, popOverlay]);
}
