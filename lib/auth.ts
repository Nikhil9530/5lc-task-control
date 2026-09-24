import { router } from 'expo-router';
import { supabase } from './supabase';

// The current signed-in user's profile (id, role, hierarchy links), or null.
export async function getCurrentProfile() {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id, employee_id, full_name, email, role, department, manager_id, director_id, is_active'
    )
    .eq('id', user.id)
    .single();

  if (error) {
    console.log('getCurrentProfile error:', error.message);
    return null;
  }

  return data;
}

// Sign out and return to the login screen.
export async function signOut() {
  try {
    await supabase.auth.signOut();
  } catch (e) {
    console.log('signOut error:', e);
  } finally {
    router.replace('/');
  }
}
