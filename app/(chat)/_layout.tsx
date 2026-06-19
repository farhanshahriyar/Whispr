/**
 * WHISPR — Chat Layout
 *
 * Stack navigator for chat screens.
 * Dark theme consistent with the app's design.
 */

import React from 'react';
import { Stack } from 'expo-router';

export default function ChatLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: '#0A0A0F',
        },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: {
          fontWeight: '700',
          fontSize: 18,
        },
        contentStyle: {
          backgroundColor: '#0A0A0F',
        },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Whispr',
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name="[id]"
        options={{
          title: 'Chat',
        }}
      />
      <Stack.Screen
        name="settings"
        options={{
          title: 'Settings',
        }}
      />
    </Stack>
  );
}
