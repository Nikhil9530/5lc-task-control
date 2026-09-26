import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { goBack } from '../../lib/navigation';
import { useState } from 'react';
import {
  ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform,
  SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { supabase } from '../../lib/supabase';
import { COLORS } from '../constants/app';

export default function ForgotPasswordScreen() {
  const [employeeId, setEmployeeId] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function sendReset() {
    const id = employeeId.trim().toUpperCase();
    if (!id) {
      Alert.alert('Missing information', 'Please enter your Employee ID.');
      return;
    }
    setSending(true);
    try {
      const { data: email, error: profileError } = await supabase.rpc(
        'get_password_reset_email',
        { p_employee_id: id }
      );

      if (profileError || !email) {
        setSending(false);
        Alert.alert('Not found', 'Employee ID not found.');
        return;
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'flctaskcontrol://reset',
      });
      if (error) {
        setSending(false);
        Alert.alert('Unable to send reset email', error.message);
        return;
      }
      setSending(false);
      setSent(true);
    } catch (e) {
      setSending(false);
      Alert.alert('Error', 'Something went wrong. Please try again.');
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => goBack()}>
            <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
          </TouchableOpacity>
          <View>
            <Text style={styles.headerTitle}>Reset Password</Text>
            <Text style={styles.headerSubtitle}>We will email you a reset link</Text>
          </View>
        </View>

        <View style={styles.body}>
          <View style={styles.card}>
            {sent ? (
              <View style={styles.sentBox}>
                <View style={styles.sentIcon}>
                  <Ionicons name="mail-outline" size={30} color={COLORS.green} />
                </View>
                <Text style={styles.sentTitle}>Check your email</Text>
                <Text style={styles.sentText}>
                  If an account exists for this Employee ID, a password reset link has
                  been sent. Follow the link to set a new password, then sign in.
                </Text>
                <TouchableOpacity style={styles.primaryButton} onPress={() => router.replace('/')}>
                  <Text style={styles.primaryButtonText}>BACK TO SIGN IN</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.label}>EMPLOYEE ID</Text>
                <View style={styles.inputBox}>
                  <Ionicons name="person-outline" size={21} color={COLORS.textSoft} />
                  <TextInput
                    value={employeeId}
                    onChangeText={setEmployeeId}
                    style={styles.input}
                    placeholder="Enter employee ID"
                    placeholderTextColor={COLORS.textFaint}
                    autoCapitalize="characters"
                  />
                </View>
                <TouchableOpacity
                  style={[styles.primaryButton, sending && styles.disabled]}
                  activeOpacity={0.85}
                  disabled={sending}
                  onPress={sendReset}
                >
                  {sending ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryButtonText}>SEND RESET LINK</Text>
                  )}
                </TouchableOpacity>
                <Text style={styles.hint}>
                  Your company email on file will receive the reset link. If you do not
                  have access, contact your Super Admin.
                </Text>
              </>
            )}
          </View>

          <Image source={require('../../assets/logo.png')} style={styles.logo} resizeMode="contain" />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
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
  body: { flex: 1, padding: 20, justifyContent: 'space-between' },
  card: {
    backgroundColor: COLORS.card, borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: COLORS.border, marginTop: 20,
  },
  label: {
    color: COLORS.navySoft, fontSize: 11, fontWeight: '800',
    letterSpacing: 1.2, marginBottom: 7,
  },
  inputBox: {
    height: 53, borderWidth: 1, borderColor: '#DCE1E6', backgroundColor: '#FAFBFC',
    borderRadius: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14,
  },
  input: { flex: 1, height: '100%', marginLeft: 10, color: COLORS.text, fontSize: 14 },
  primaryButton: {
    height: 52, backgroundColor: COLORS.navy, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', marginTop: 20,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900', letterSpacing: 1.2 },
  disabled: { opacity: 0.6 },
  hint: { color: COLORS.textSoft, fontSize: 11, lineHeight: 16, marginTop: 16 },
  sentBox: { alignItems: 'center' },
  sentIcon: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.greenSoft,
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  sentTitle: { color: COLORS.navy, fontSize: 17, fontWeight: '900' },
  sentText: {
    color: COLORS.textSoft, fontSize: 12, lineHeight: 18,
    textAlign: 'center', marginTop: 8, marginBottom: 6,
  },
  logo: { width: 140, height: 44, alignSelf: 'center', opacity: 0.85 },
});