import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { nav } from '../../lib/navigation';
import { useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { supabase } from '../../lib/supabase';

export default function LoginScreen() {
  const [showPassword, setShowPassword] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.page}>

          {/* Top branding */}
          <View style={styles.header}>
            <Image
              source={require('../../assets/logo.png')}
              style={styles.logo}
              resizeMode="contain"
            />

            <View style={styles.brandLine} />

            <Text style={styles.controlTitle}>TASK CONTROL</Text>
            <Text style={styles.controlSubtitle}>
              COMPANY WORK MANAGEMENT
            </Text>
          </View>

          {/* Login card */}
          <View style={styles.card}>

            <View style={styles.cardHeader}>
              <View>
                <Text style={styles.welcome}>Welcome Back</Text>
                <Text style={styles.signInText}>
                  Sign in to continue
                </Text>
              </View>

              <View style={styles.lockCircle}>
                <Ionicons
                  name="shield-checkmark-outline"
                  size={25}
                  color="#F28C28"
                />
              </View>
            </View>

            {/* Employee ID */}
            <Text style={styles.label}>EMPLOYEE ID</Text>

            <View style={styles.inputBox}>
              <Ionicons
                name="person-outline"
                size={21}
                color="#7C8795"
              />

              <TextInput
                value={employeeId}
                onChangeText={setEmployeeId}
                style={styles.input}
                placeholder="Enter employee ID"
                placeholderTextColor="#9BA4AF"
                autoCapitalize="characters"
              />
            </View>

            {/* Password */}
            <Text style={styles.label}>PASSWORD</Text>

            <View style={styles.inputBox}>
              <Ionicons
                name="lock-closed-outline"
                size={20}
                color="#7C8795"
              />

              <TextInput
                value={password}
                onChangeText={setPassword}
                style={styles.input}
                placeholder="Enter password"
                placeholderTextColor="#9BA4AF"
                secureTextEntry={!showPassword}
              />

              <TouchableOpacity
                onPress={() => setShowPassword(!showPassword)}
                hitSlop={10}
              >
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={21}
                  color="#7C8795"
                />
              </TouchableOpacity>
            </View>

            {/* Forgot password */}
            <TouchableOpacity
              style={styles.forgotButton}
              onPress={() => nav('/forgot-password')}
            >
              <Text style={styles.forgotText}>
                Forgot Password?
              </Text>
            </TouchableOpacity>

            {/* Sign in */}
            <TouchableOpacity
  activeOpacity={0.85}
  style={styles.signInButton}
  onPress={async () => {
  if (!employeeId.trim() || !password.trim()) {
    alert('Please enter your Employee ID and Password.');
    return;
  }

  const { data: email, error: profileError } = await supabase.rpc(
  'get_login_email',
  {
    p_employee_id: employeeId.trim().toUpperCase(),
  }
);

if (profileError || !email) {
  alert('Employee ID not found.');
  return;
}

  const { error } = await supabase.auth.signInWithPassword({
    email: email,
    password,
  });

  if (error) {
    alert(error.message);
    return;
  }

  router.replace('/dashboard');
}}
>
                <Text style={styles.signInButtonText}>
                SIGN IN
              </Text>

              <View style={styles.arrow}>
                <Ionicons
                  name="arrow-forward"
                  size={19}
                  color="#FFFFFF"
                />
              </View>
            </TouchableOpacity>

          </View>

          {/* Bottom information */}
          <View style={styles.footer}>

            <View style={styles.footerLine}>
              <View style={styles.smallLine} />
              <Text style={styles.footerLabel}>
                5LC TASK CONTROL
              </Text>
              <View style={styles.smallLine} />
            </View>

            <Text style={styles.footerText}>
              Every commitment. Every deadline. Every follow-up.
            </Text>

            <Text style={styles.version}>
              Secure Company Operations • v1.0
            </Text>

          </View>

        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F5F7',
  },

  keyboard: {
    flex: 1,
  },

  page: {
  flex: 1,
  width: '100%',
  maxWidth: 520,
  alignSelf: 'center',
  paddingHorizontal: 24,
  paddingVertical: 24,
  justifyContent: 'center',
},

  /* ---------- BRAND ---------- */

  header: {
  alignItems: 'center',
  marginBottom: 28,
},

  logo: {
    width: 285,
    height: 82,
  },

  brandLine: {
    width: 48,
    height: 4,
    backgroundColor: '#F28C28',
    borderRadius: 3,
    marginTop: 13,
  },

  controlTitle: {
    marginTop: 11,
    color: '#12233F',
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 3,
  },

  controlSubtitle: {
    marginTop: 4,
    color: '#7A8491',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 2,
  },

  /* ---------- CARD ---------- */

  card: {
  width: '100%',
  backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingHorizontal: 23,
    paddingVertical: 24,

    borderWidth: 1,
    borderColor: '#E2E6EA',

    shadowColor: '#12233F',
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 5,
  },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 19,
  },

  welcome: {
    color: '#12233F',
    fontSize: 25,
    fontWeight: '800',
  },

  signInText: {
    color: '#7B8490',
    fontSize: 13,
    marginTop: 4,
  },

  lockCircle: {
    width: 49,
    height: 49,
    borderRadius: 25,
    backgroundColor: '#FFF3E7',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ---------- INPUTS ---------- */

  label: {
    color: '#344258',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 7,
    marginTop: 12,
  },

  inputBox: {
    height: 53,
    borderWidth: 1,
    borderColor: '#DCE1E6',
    backgroundColor: '#FAFBFC',
    borderRadius: 10,

    flexDirection: 'row',
    alignItems: 'center',

    paddingHorizontal: 14,
  },

  input: {
    flex: 1,
    height: '100%',
    marginLeft: 10,

    color: '#182337',
    fontSize: 14,
  },

  forgotButton: {
    alignSelf: 'flex-end',
    marginTop: 11,
  },

  forgotText: {
    color: '#E87917',
    fontSize: 12,
    fontWeight: '700',
  },

  /* ---------- BUTTON ---------- */

  signInButton: {
    height: 55,
    backgroundColor: '#12233F',
    borderRadius: 10,

    marginTop: 20,

    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',

    shadowColor: '#12233F',
    shadowOffset: {
      width: 0,
      height: 5,
    },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 4,
  },

  signInButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 1.5,
  },

  arrow: {
    marginLeft: 11,
  },

  /* ---------- FOOTER ---------- */

  footer: {
  alignItems: 'center',
  marginTop: 28,
},

  footerLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 9,
  },

  smallLine: {
    width: 27,
    height: 1,
    backgroundColor: '#D3D8DE',
    marginHorizontal: 9,
  },

  footerLabel: {
    color: '#12233F',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.5,
  },

  footerText: {
    color: '#7D8792',
    fontSize: 10,
    textAlign: 'center',
  },

  version: {
    color: '#A6ADB5',
    fontSize: 9,
    marginTop: 5,
  },
});