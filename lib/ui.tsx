import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../src/constants/app';

// ----------------------------------------------------------------------------
// Shared UI primitives — one feel everywhere.
// ----------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------
// Every screen hand-rolled its own TouchableOpacity (activeOpacity jumping
// between 0.8 and 0.85), its own spinner, its own card borders and shadows.
// That inconsistency IS the "noob" feel: nothing responds the same way twice,
// and every screen flashes a spinner on open.
// These primitives fix that in one place:
//   AppPress  -> Android ripple + subtle opacity. Feels instant and native.
//   Skeleton  -> shimmering placeholder that holds layout, so content fades in
//                instead of popping. Replaces full-screen spinners.
//   Screen    -> one background + padding contract.
//   EmptyState-> one "nothing here" look.
// ----------------------------------------------------------------------------

export function AppPress({
  children,
  onPress,
  style,
  disabled,
  hitSlop,
}: {
  children?: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  // Generous invisible tap area around small icon-only targets, so a control
  // does not have to be visually large to be easy to hit.
  hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      android_ripple={{ color: 'rgba(18,35,63,0.08)', borderless: false }}
      style={({ pressed }) => [
        { opacity: pressed && !disabled ? 0.86 : 1 },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

export function Skeleton({
  width,
  height,
  radius = 8,
  style,
}: {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 750,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          borderRadius: radius,
          backgroundColor: '#E4E8EC',
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

export function SkeletonCard() {
  return (
    <View style={ui.card}>
      <Skeleton width="70%" height={15} />
      <View style={{ height: 10 }} />
      <Skeleton width="45%" height={12} />
      <View style={{ height: 12 }} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Skeleton width={64} height={22} radius={11} />
        <Skeleton width={64} height={22} radius={11} />
      </View>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  message: string;
}) {
  return (
    <View style={ui.emptyCard}>
      <View style={ui.emptyIcon}>
        <Ionicons name={icon} size={28} color={COLORS.textFaint} />
      </View>
      <Text style={ui.emptyTitle}>{title}</Text>
      <Text style={ui.emptyText}>{message}</Text>
    </View>
  );
}

const ui = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    padding: 15,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emptyCard: {
    marginTop: 32,
    padding: 28,
    borderRadius: 16,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#F0F2F4',
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyTitle: {
    marginTop: 14,
    color: COLORS.navy,
    fontSize: 16,
    fontWeight: '900',
  },
  emptyText: {
    marginTop: 7,
    color: COLORS.textSoft,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    maxWidth: 280,
  },
});
