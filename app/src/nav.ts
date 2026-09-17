import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

/** A tap that lands while the JS thread is busy is not dropped — iOS queues it
 *  and React Native delivers the whole backlog at once as soon as the thread
 *  breathes again. On a list row that means the same screen gets pushed once
 *  per impatient tap, and the only way out is one back press per push.
 *
 *  Returns a wrapper that lets the first tap through and ignores the rest until
 *  the navigation it started has taken this screen off-focus (or, if nothing
 *  moved at all, until a moment has passed — an inert list would be worse than
 *  a duplicate push). */
export function useNavGuard(): (go: () => void) => void {
  const locked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useFocusEffect(useCallback(() => {
    // Back on screen: whatever we pushed has been dismissed, accept taps again.
    locked.current = false;
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, []));

  return useCallback((go: () => void) => {
    if (locked.current) return;
    locked.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { locked.current = false; timer.current = null; }, 1000);
    go();
  }, []);
}
