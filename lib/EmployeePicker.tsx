import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../src/constants/app';
import { AppPress } from './ui';

// ----------------------------------------------------------------------------
// EmployeePicker - a dropdown that stays a dropdown at any company size.
// ----------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------
// "Assign To" used to render every candidate INLINE inside the page's
// ScrollView. Fine for 5 people, unusable for 50: the list grew to 50 x 60px
// and pushed Due Date + Create Task thousands of pixels down the page, turning
// the form into a mile long.
//
// The trap this replaces: putting that list inside a View with `maxHeight` does
// NOT fix it. In React Native `maxHeight` alone does not clip - children render
// outside the box and paint OVER whatever follows, which is exactly the
// "list superimposes on the button" bug. A list is only contained when it is
// genuinely scrollable (FlatList / ScrollView).
//
// This opens in a Modal bottom sheet with search + a virtualised list, so the
// form's height is fixed no matter how many employees exist. UUIDs are never
// shown - only name, employee id, department and role.
// ----------------------------------------------------------------------------

export type PickerEmployee = {
  id: string;
  employee_id: string;
  full_name: string;
  role?: string | null;
  department?: string | null;
};

export function EmployeePicker({
  employees,
  value,
  onChange,
  loading = false,
  placeholder = 'Select employee',
  searchPlaceholder = 'Search employee...',
  emptyMessage = 'No employees available.',
  style,
  allowClear = false,
}: {
  employees: PickerEmployee[];
  value: string | null;
  onChange: (id: string) => void;
  loading?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  style?: StyleProp<ViewStyle>;
  allowClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = useMemo(
    () => employees.find((e) => e.id === value) ?? null,
    [employees, value]
  );

  // Filter across every field someone might plausibly search by.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;

    return employees.filter((e) =>
      [e.full_name, e.employee_id, e.department, e.role]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q))
    );
  }, [employees, query]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function choose(id: string) {
    onChange(id);
    close();
  }

  return (
    <>
      {/* Closed state: looks exactly like an ordinary dropdown field. */}
      <AppPress
        style={[styles.field, style]}
        onPress={() => setOpen(true)}
        disabled={loading}
      >
        <Ionicons name="person-outline" size={20} color={COLORS.textFaint} />

        <Text
          numberOfLines={1}
          style={[styles.fieldText, !selected && { color: COLORS.textFaint }]}
        >
          {loading
            ? 'Loading employees...'
            : selected
              ? selected.full_name
              : placeholder}
        </Text>

        {allowClear && selected ? (
          <AppPress
            hitSlop={8}
            onPress={() => {
              onChange('');
              close();
            }}
          >
            <Ionicons name="close-circle" size={18} color={COLORS.textFaint} />
          </AppPress>
        ) : null}

        <Ionicons name="chevron-down" size={18} color={COLORS.textFaint} />
      </AppPress>

      {/* Open state: a bottom sheet. The list scrolls INSIDE the sheet, so it
          can never grow over the form behind it. */}
      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={close}
      >
        <View style={styles.backdrop}>
          {/* Tap-outside-to-close target, sitting behind the sheet. */}
          <AppPress style={styles.backdropTap} onPress={close} />

          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Select employee</Text>

              <AppPress onPress={close} hitSlop={10}>
                <Ionicons name="close" size={22} color={COLORS.textSoft} />
              </AppPress>
            </View>

            <View style={styles.searchWrap}>
              <Ionicons name="search" size={17} color={COLORS.textFaint} />

              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={searchPlaceholder}
                placeholderTextColor={COLORS.textFaint}
                style={styles.search}
                autoCorrect={false}
                autoCapitalize="none"
              />

              {query.length > 0 ? (
                <AppPress onPress={() => setQuery('')} hitSlop={10}>
                  <Ionicons
                    name="close-circle"
                    size={17}
                    color={COLORS.textFaint}
                  />
                </AppPress>
              ) : null}
            </View>

            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              initialNumToRender={12}
              maxToRenderPerBatch={12}
              windowSize={7}
              renderItem={({ item }) => {
                const isSelected = item.id === value;

                return (
                  <AppPress
                    style={[styles.row, isSelected && styles.rowSelected]}
                    onPress={() => choose(item.id)}
                  >
                    <View style={styles.rowAvatar}>
                      <Text style={styles.rowAvatarText}>
                        {(item.full_name || '?').charAt(0).toUpperCase()}
                      </Text>
                    </View>

                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {item.full_name}
                      </Text>

                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {item.employee_id}
                        {item.department ? `  •  ${item.department}` : ''}
                        {item.role
                          ? `  •  ${String(item.role).replace('_', ' ')}`
                          : ''}
                      </Text>
                    </View>

                    {isSelected && (
                      <Ionicons
                        name="checkmark-circle"
                        size={21}
                        color={COLORS.orange}
                      />
                    )}
                  </AppPress>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.empty}>
                  {query.trim()
                    ? `No employee matches "${query.trim()}".`
                    : emptyMessage}
                </Text>
              }
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // Closed-state field. Callers pass `style` to match their own screen's input
  // metrics (create-task, for example, uses marginHorizontal: 20).
  field: {
    height: 52,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: '#DCE1E6',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  fieldText: {
    flex: 1,
    marginHorizontal: 10,
    color: COLORS.text,
    fontSize: 14,
  },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(18,35,63,0.55)',
    justifyContent: 'flex-end',
  },
  backdropTap: { flex: 1 },
  sheet: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    // Fixed ceiling: the sheet can never grow with the employee count.
    maxHeight: '75%',
    paddingBottom: Platform.OS === 'ios' ? 26 : 14,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  sheetTitle: {
    color: COLORS.navy,
    fontSize: 17,
    fontWeight: '900',
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 10,
    paddingHorizontal: 12,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#F7F8FA',
    borderWidth: 1,
    borderColor: '#DCE1E6',
  },
  search: {
    flex: 1,
    marginLeft: 9,
    color: COLORS.text,
    fontSize: 14,
  },

  // flexShrink rather than a fixed height: the list takes only the room it
  // needs and scrolls internally. This is the containment maxHeight-on-a-View
  // could never provide.
  list: { flexShrink: 1 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#EDF0F2',
  },
  rowSelected: { backgroundColor: COLORS.orangeSoft },
  rowAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.navy,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  rowAvatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  rowName: {
    color: COLORS.navy,
    fontSize: 14,
    fontWeight: '800',
  },
  rowMeta: {
    color: COLORS.textFaint,
    fontSize: 10,
    marginTop: 2,
  },
  empty: {
    padding: 26,
    textAlign: 'center',
    color: COLORS.textSoft,
    fontSize: 12,
    lineHeight: 17,
  },
});
