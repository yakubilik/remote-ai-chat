import { requireNativeModule } from 'expo-modules-core';
import { useEffect } from 'react';
import { Platform } from 'react-native';

/** One file that was dropped, already copied somewhere this app can read it.
 *  The same shape the pickers hand over, so it joins their upload path. */
export interface DroppedFile {
  uri: string;
  name: string;
  size: number;
}

interface DropModule {
  start(): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'onDrop', listener: (payload: { files: DroppedFile[] }) => void): { remove(): void };
  addListener(event: 'onDragEnter' | 'onDragExit', listener: () => void): { remove(): void };
}

/** Only iOS has a system-wide drag between apps on a phone; everywhere else
 *  this does nothing and the attach button is the way in. A module that failed
 *  to load must not take the chat screen down with it, hence the try. */
const native: DropModule | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    return requireNativeModule<DropModule>('RacDropTarget');
  } catch {
    // A build that predates the module, or one where autolinking did not pick
    // it up. Worth a line: the feature would otherwise be missing in silence.
    console.warn('drop-target: the native module is not in this build');
    return null;
  }
})();

export interface FileDropHandlers {
  /** Everything from one drag, in the order it was dragged. */
  onDrop: (files: DroppedFile[]) => void;
  /** Something is being held over the app, and would land if let go. */
  onEnter?: () => void;
  /** It left again, or it landed. */
  onExit?: () => void;
}

/** Accept files dragged in from another app for as long as this screen is the
 *  one on show. `enabled` is what stops a chat that has been navigated away
 *  from collecting a drop meant for the one in front of it. */
export function useFileDrop(enabled: boolean, handlers: FileDropHandlers) {
  const { onDrop, onEnter, onExit } = handlers;
  useEffect(() => {
    if (!native || !enabled) return;
    const subs = [
      native.addListener('onDrop', (payload) => onDrop(payload?.files ?? [])),
      native.addListener('onDragEnter', () => onEnter?.()),
      native.addListener('onDragExit', () => onExit?.()),
    ];
    native.start().catch((e) => console.warn('drop-target: could not start', e));
    return () => {
      for (const sub of subs) sub.remove();
      native.stop().catch(() => {});
    };
  }, [enabled, onDrop, onEnter, onExit]);
}

/** Whether this build can take a drop at all — for a screen that wants to say so. */
export const fileDropAvailable = native != null;
