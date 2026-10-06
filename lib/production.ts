import { supabase } from './supabase';

export type ProductionDepartment = 'laser' | 'bending' | 'fabrication';

type Row = Record<string, unknown>;

export type Metric = { label: string; value: string; detail: string };
export type Breakdown = { name: string; primary: number; secondary?: number };
export type ProductionReport = {
  department: ProductionDepartment;
  month: string;
  months: string[];
  asOf: string | null;
  metrics: Metric[];
  breakdown: Breakdown[];
  daily: { date: string; value: number }[];
  monthly: { month: string; values: Record<string, number>; breakdown: Breakdown[] }[];
};

export type ProductionData = {
  laser: Row[];
  outsource: Row[];
  laserManpower: Row[];
  bending: Row[];
  fabrication: Row[];
};

const number = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const text = (value: unknown) => String(value ?? '').trim();
const sum = <T,>(rows: T[], select: (row: T) => number) => rows.reduce((total, row) => total + select(row), 0);
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const monthOf = (row: Row) => text(row.source_month) || text(row.work_date).slice(0, 7);
const formatMonth = (month: string) => {
  const [year, rawMonth] = month.split('-');
  const date = new Date(Number(year), Number(rawMonth) - 1, 1);
  return new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' }).format(date);
};
const kg = (value: number) => `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)} kg`;
const rupees = (value: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)}`;
const rate = (value: number) => `₹${round(value, 2).toFixed(2)}`;

export async function loadProductionData(): Promise<ProductionData> {
  const [laser, outsource, laserManpower, bending, fabrication] = await Promise.all([
    supabase.from('laser_production').select('*').order('work_date'),
    supabase.from('laser_outsource').select('*').order('work_date'),
    supabase.from('laser_manpower').select('*').order('work_date'),
    supabase.from('bending_daily').select('*').order('work_date'),
    supabase.from('fabrication_daily').select('*').order('work_date'),
  ]);
  const failed = [laser, outsource, laserManpower, bending, fabrication].find((result) => result.error);
  if (failed?.error) throw failed.error;
  return {
    laser: (laser.data ?? []) as Row[],
    outsource: (outsource.data ?? []) as Row[],
    laserManpower: (laserManpower.data ?? []) as Row[],
    bending: (bending.data ?? []) as Row[],
    fabrication: (fabrication.data ?? []) as Row[],
  };
}

export function availableMonths(data: ProductionData): string[] {
  return [...new Set([...data.laser, ...data.bending, ...data.fabrication].map(monthOf).filter(Boolean))].sort();
}

export function buildReport(data: ProductionData, department: ProductionDepartment, month: string): ProductionReport {
  const months = availableMonths(data);
  const selected = month || months[months.length - 1] || '';
  const report = department === 'laser'
    ? laserReport(data, selected, true)
    : department === 'bending'
      ? bendingReport(data, selected, true)
      : fabricationReport(data, selected, true);
  return { ...report, months, month: selected };
}

function laserReport(data: ProductionData, month: string, includeMonthly = false): Omit<ProductionReport, 'months' | 'month'> {
  const rows = data.laser.filter((row) => monthOf(row) === month);
  const outsourced = data.outsource.filter((row) => monthOf(row) === month);
  const manpower = data.laserManpower.filter((row) => monthOf(row) === month);
  const ownWeight = sum(rows, (row) => number(row.weight_kg));
  const outsourceWeight = sum(outsourced, (row) => number(row.weight_kg));
  const sheets = sum(rows, (row) => number(row.sheets));
  const periphery = sum(rows, (row) => number(row.periphery_mmm));
  const cost = sum(manpower, (row) => number(row.cost_inr));
  const byMachine = group(rows, 'machine', (groupRows) => ({
    primary: sum(groupRows, (row) => number(row.weight_kg)),
    secondary: sum(manpower.filter((costRow) => text(costRow.machine) === text(groupRows[0]?.machine)), (row) => number(row.cost_inr)),
  }));
  const daily = groupByDate(rows, (groupRows) => sum(groupRows, (row) => number(row.weight_kg)));
  return {
    department: 'laser', asOf: latestDate(rows),
    metrics: [
      { label: 'Total Weight Cut', value: kg(ownWeight), detail: `${round(ownWeight / 1000, 1)} tonnes` },
      { label: 'Total Sheets Cut', value: new Intl.NumberFormat('en-IN').format(sheets), detail: 'All machines' },
      { label: 'Total Periphery', value: new Intl.NumberFormat('en-IN').format(round(periphery)), detail: 'M-MM cutting length' },
      { label: 'Total Manpower Cost', value: rupees(cost), detail: 'Legacy dashboard cost basis' },
      { label: 'Avg Cost / kg', value: rate(ownWeight ? cost / ownWeight : 0), detail: 'Manpower ÷ in-house weight' },
      { label: 'Avg ₹ / M-MM', value: rate(periphery ? cost / periphery : 0), detail: 'Manpower ÷ periphery' },
      { label: 'Weight (In + Out)', value: kg(ownWeight + outsourceWeight), detail: `Outsourced ${kg(outsourceWeight)}` },
    ],
    breakdown: [...byMachine.entries()].map(([name, values]) => ({ name, ...values })).sort((a, b) => b.primary - a.primary),
    daily,
    monthly: includeMonthly ? monthlyReports(data, 'laser') : [],
  };
}

function bendingReport(data: ProductionData, month: string, includeMonthly = false): Omit<ProductionReport, 'months' | 'month'> {
  const rows = data.bending.filter((row) => monthOf(row) === month);
  const strokes = sum(rows, (row) => number(row.strokes));
  const weight = sum(rows, (row) => number(row.weight_kg));
  const cost = sum(rows, (row) => number(row.manpower_cost));
  const downtime = new Set(rows.filter((row) => text(row.remark) && new Date(`${text(row.work_date)}T00:00:00`).getDay() !== 0)
    .map((row) => `${text(row.machine)}|${text(row.work_date)}`)).size;
  const byMachine = group(rows, 'machine', (groupRows) => ({
    primary: sum(groupRows, (row) => number(row.strokes)),
    secondary: sum(groupRows, (row) => number(row.weight_kg)),
  }));
  return {
    department: 'bending', asOf: latestDate(rows),
    metrics: [
      { label: 'Total Strokes', value: new Intl.NumberFormat('en-IN').format(strokes), detail: 'All machines' },
      { label: 'Total Weight', value: kg(weight), detail: 'All machines' },
      { label: '₹ / Stroke', value: rate(strokes ? cost / strokes : 0), detail: 'Manpower ÷ strokes' },
      { label: '₹ / kg', value: rate(weight ? cost / weight : 0), detail: 'Manpower ÷ weight' },
      { label: 'Manpower Cost', value: rupees(cost), detail: 'All shifts' },
      { label: 'Downtime Events', value: String(downtime), detail: 'Non-Sunday machine-days with remarks' },
    ],
    breakdown: [...byMachine.entries()].map(([name, values]) => ({ name, ...values })).sort((a, b) => b.primary - a.primary),
    daily: groupByDate(rows, (groupRows) => sum(groupRows, (row) => number(row.strokes))),
    monthly: includeMonthly ? monthlyReports(data, 'bending') : [],
  };
}

function fabricationReport(data: ProductionData, month: string, includeMonthly = false): Omit<ProductionReport, 'months' | 'month'> {
  const rows = data.fabrication.filter((row) => monthOf(row) === month);
  const weight = sum(rows, (row) => number(row.weight_kg) || number(row.unit_weight_kg) * number(row.quantity));
  // Exact dashboard rule: quantities are rounded per raw row, not after summing.
  const pieces = sum(rows, (row) => Math.round(number(row.quantity)));
  const cost = sum(rows, (row) => number(row.manpower_cost));
  const byStation = group(rows, 'station', (groupRows) => ({
    primary: sum(groupRows, (row) => number(row.weight_kg) || number(row.unit_weight_kg) * number(row.quantity)),
    secondary: sum(groupRows, (row) => Math.round(number(row.quantity))),
  }));
  return {
    department: 'fabrication', asOf: latestDate(rows),
    metrics: [
      { label: 'Total Weight', value: kg(weight), detail: 'All stations' },
      { label: 'Total Pieces', value: new Intl.NumberFormat('en-IN').format(pieces), detail: 'Legacy per-row rounding' },
      { label: '₹ / kg', value: rate(weight ? cost / weight : 0), detail: 'Manpower ÷ weight' },
      { label: '₹ / Piece', value: rate(pieces ? cost / pieces : 0), detail: 'Manpower ÷ pieces' },
      { label: 'Manpower Cost', value: rupees(cost), detail: 'All stations' },
      { label: 'Stations Active', value: `${new Set(rows.map((row) => text(row.station))).size} / 3`, detail: 'Stations with source rows' },
    ],
    breakdown: [...byStation.entries()].map(([name, values]) => ({ name, ...values })).sort((a, b) => b.primary - a.primary),
    daily: groupByDate(rows, (groupRows) => sum(groupRows, (row) => number(row.weight_kg) || number(row.unit_weight_kg) * number(row.quantity))),
    monthly: includeMonthly ? monthlyReports(data, 'fabrication') : [],
  };
}

function monthlyReports(data: ProductionData, department: ProductionDepartment) {
  return availableMonths(data).map((month) => {
    const report = department === 'laser' ? laserReport(data, month) : department === 'bending' ? bendingReport(data, month) : fabricationReport(data, month);
    return {
      month,
      values: Object.fromEntries(report.metrics.map((metric) => [metric.label, Number(metric.value.replace(/[^0-9.]/g, '')) || 0])),
      breakdown: report.breakdown,
    };
  });
}

function group(rows: Row[], key: string, calculate: (rows: Row[]) => { primary: number; secondary?: number }) {
  const grouped = new Map<string, Row[]>();
  rows.forEach((row) => {
    const value = text(row[key]) || 'Unspecified';
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  });
  return new Map([...grouped.entries()].map(([name, groupRows]) => [name, calculate(groupRows)]));
}

function groupByDate(rows: Row[], calculate: (rows: Row[]) => number) {
  const grouped = group(rows, 'work_date', (groupRows) => ({ primary: calculate(groupRows) }));
  return [...grouped.entries()].map(([date, values]) => ({ date, value: values.primary })).sort((a, b) => a.date.localeCompare(b.date));
}

function latestDate(rows: Row[]) {
  const dates = rows.map((row) => text(row.work_date)).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

export { formatMonth };
