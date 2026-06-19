/**
 * WHISPR — MessageBubble Component
 *
 * Renders a single message with sender/receiver styling,
 * timestamp, and read/delivered indicators.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { DecryptedMessage } from '../types';

interface MessageBubbleProps {
  message: DecryptedMessage;
}

/**
 * Status indicator:
 *   ✓  = Sent (inserted into Supabase)
 *   ✓✓ = Delivered
 *   ✓✓ (blue) = Read
 */
function getStatusIcon(message: DecryptedMessage): string {
  if (!message.isMine) return '';
  if (message.read) return '✓✓';
  if (message.delivered) return '✓✓';
  return '✓';
}

function getStatusColor(message: DecryptedMessage): string {
  if (message.read) return '#6C63FF'; // Purple accent when read
  return '#8E8E93'; // Grey for sent/delivered
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const statusIcon = getStatusIcon(message);
  const statusColor = getStatusColor(message);

  return (
    <View
      style={[
        styles.container,
        message.isMine ? styles.myMessage : styles.theirMessage,
      ]}
    >
      <View
        style={[
          styles.bubble,
          message.isMine ? styles.myBubble : styles.theirBubble,
        ]}
      >
        <Text
          style={[
            styles.messageText,
            message.isMine ? styles.myText : styles.theirText,
          ]}
        >
          {message.content}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.timestamp}>
            {formatTime(message.createdAt)}
          </Text>
          {message.isMine && statusIcon ? (
            <Text style={[styles.status, { color: statusColor }]}>
              {' '}{statusIcon}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    marginVertical: 3,
  },
  myMessage: {
    alignItems: 'flex-end',
  },
  theirMessage: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
    borderRadius: 18,
  },
  myBubble: {
    backgroundColor: '#6C63FF',
    borderBottomRightRadius: 4,
  },
  theirBubble: {
    backgroundColor: '#1E1E2E',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  myText: {
    color: '#FFFFFF',
  },
  theirText: {
    color: '#E0E0E8',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 4,
  },
  timestamp: {
    fontSize: 11,
    color: '#8E8E93',
  },
  status: {
    fontSize: 12,
    fontWeight: '600',
  },
});
