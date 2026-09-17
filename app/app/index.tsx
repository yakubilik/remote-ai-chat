import React from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { useStore } from '../src/store';
import { colors } from '../src/theme';

export default function Index() {
  const ready = useStore((s) => s.ready);
  const host = useStore((s) => s.host);
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return <Redirect href={host ? '/chats' : '/pair'} />;
}
