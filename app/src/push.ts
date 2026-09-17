import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { AppState } from 'react-native';

/** The chat currently on screen, if any. Kept here rather than in the store so
 *  the notification handler does not have to import it — the store imports this
 *  module. */
let onScreen: string | null = null;
export function setChatOnScreen(id: string | null) { onScreen = id; }

/** The chat the user is *in*, which outlives losing focus: a sheet on top of the
 *  chat, or the app going to the background, does not take them off it. Used to
 *  decide what a notification tap should do. */
let openChat: string | null = null;
export function setOpenChat(id: string | null) { openChat = id; }
export function getOpenChat(): string | null { return openChat; }

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const chatId = (n.request.content.data as any)?.chat_id;
    // Announcing a chat the user is already reading is noise; everything else
    // gets a banner, including while the app is open.
    const mute = !!chatId && chatId === onScreen && AppState.currentState === 'active';
    return { shouldShowBanner: !mute, shouldShowList: true, shouldPlaySound: !mute, shouldSetBadge: false };
  },
});

/** Returns an Expo push token, or null when this build cannot receive push
 *  (simulator, Expo Go without an EAS project id, permission denied). */
export async function registerForPush(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null;
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return null;
    const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return token.data;
  } catch (e) {
    console.warn('push registration failed', e);
    return null;
  }
}
