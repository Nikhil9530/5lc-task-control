import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Platform, SafeAreaView, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { router } from 'expo-router';
import { goBack } from '../../lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { getSessionProfile, signOut } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { COLORS } from '../constants/app';

type Profile = {
  employee_id: string;
  full_name: string;
  email: string;
  role: string;
  department: string | null;
};

export default function SettingsScreen() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changing, setChanging] = useState(false);

  const load = useCallback(async () => {
    const me = await getSessionProfile();
    if (!me) {
      Alert.alert('Session Expired', 'Please log in again.');
      router.replace('/');
      return;
    }
    setProfile(me as Profile);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function confirmSignOut() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  }

  async function changePassword() {
    if (changing) return;

    if (newPassword.length < 6) {
      Alert.alert('Too Short', 'Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Mismatch', 'The two passwords do not match.');
      return;
    }

    setChanging(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        Alert.alert('Unable to change password', error.message);
        return;
      }
      setNewPassword('');
      setConfirmPassword('');
      Alert.alert('Password Updated', 'Your password has been changed. Use it next time you sign in.');
    } finally {
      setChanging(false);
    }
  }

  const version =
    Constants.expoConfig?.version ??
    (Constants as any)?.manifest?.version ??
    '1.0.0';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => goBack()}>
          <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Settings</Text>
          <Text style={styles.headerSubtitle}>Your account & preferences</Text>
        </View>
        <Ionicons name="settings-outline" size={22} color={COLORS.orange} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.orange} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.profileCard}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(profile?.full_name || 'U').charAt(0).toUpperCase()}
              </Text>
            </View>
            <Text style={styles.name}>{profile?.full_name}</Text>
            <Text style={styles.role}>{(profile?.role || '').replace('_', ' ').toUpperCase()}</Text>
          </View>

          <View style={styles.card}>
            <Row label="EMPLOYEE ID" value={profile?.employee_id} />
            <Divider />
            <Row label="EMAIL" value={profile?.email} />
            <Divider />
            <Row label="DEPARTMENT" value={profile?.department || 'Not set'} />
          </View>

          {/* CHANGE PASSWORD */}
          <View style={[styles.card, { paddingVertical: 8, marginTop: 16 }]}>
            <View style={styles.pwHeader}>
              <Ionicons name="key-outline" size={18} color={COLORS.orange} />
              <Text style={styles.pwTitle}>Change Password</Text>
            </View>

            <TextInput
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="New password (min 6 characters)"
              placeholderTextColor={COLORS.textFaint}
              secureTextEntry
              style={styles.pwInput}
            />

            <TextInput
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Confirm new password"
              placeholderTextColor={COLORS.textFaint}
              secureTextEntry
              style={styles.pwInput}
            />

            <TouchableOpacity
              style={[styles.pwButton, changing && styles.pwButtonDisabled]}
              activeOpacity={0.85}
              disabled={changing}
              onPress={changePassword}
            >
              {changing ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.pwButtonText}>UPDATE PASSWORD</Text>
              )}
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.signOutButton} activeOpacity={0.85} onPress={confirmSignOut}>
            <Ionicons name="log-out-outline" size={20} color="#FFFFFF" />
            <Text style={styles.signOutText}>SIGN OUT</Text>
          </TouchableOpacity>

          <Text style={styles.version}>5LC Task Control • v{version}</Text>
          <Text style={styles.footer}>FIVE LASER CUT — Simple • Focused • Accountable</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value || '—'}</Text>
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    backgroundColor: COLORS.navy,
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 46 : 15,
    paddingBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  backButton: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '900' },
  headerSubtitle: { color: '#B9C2CF', fontSize: 12, marginTop: 3 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 20, paddingBottom: 40 },
  profileCard: {
    backgroundColor: COLORS.card, borderRadius: 16, padding: 22,
    borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', marginBottom: 16,
  },
  avatar: {
    width: 70, height: 70, borderRadius: 35, backgroundColor: COLORS.navy,
    justifyContent: 'center', alignItems: 'center', marginBottom: 12,
  },
  avatarText: { color: '#FFFFFF', fontSize: 28, fontWeight: '900' },
  name: { color: COLORS.navy, fontSize: 18, fontWeight: '900' },
  role: { color: COLORS.orange, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 5 },
  card: {
    backgroundColor: COLORS.card, borderRadius: 14,
    borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 16,
  },
  row: {
    minHeight: 54, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLabel: { color: COLORS.textFaint, fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  rowValue: { color: COLORS.navy, fontSize: 13, fontWeight: '700', flexShrink: 1, marginLeft: 12 },
  divider: { height: 1, backgroundColor: '#EDF0F2' },
  signOutButton: {
    marginTop: 22, height: 52, borderRadius: 10, backgroundColor: COLORS.red,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  signOutText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900', letterSpacing: 1.2 },
  version: { color: COLORS.textFaint, fontSize: 10, textAlign: 'center', marginTop: 22 },
  footer: { color: COLORS.textSoft, fontSize: 9, textAlign: 'center', marginTop: 6 },

  pwHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10,
  },
  pwTitle: { color: COLORS.navy, fontSize: 14, fontWeight: '900' },
  pwInput: {
    minHeight: 48, backgroundColor: '#F7F8FA', borderWidth: 1,
    borderColor: '#DCE1E6', borderRadius: 10, paddingHorizontal: 13,
    color: COLORS.text, fontSize: 14, marginTop: 10,
  },
  pwButton: {
    height: 48, borderRadius: 10, backgroundColor: COLORS.navy,
    alignItems: 'center', justifyContent: 'center', marginTop: 14, marginBottom: 10,
  },
  pwButtonDisabled: { opacity: 0.6 },
  pwButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
});