/**
 * Shared billing utilities used by projects route and forecast service.
 */

const INTERVAL_MULTIPLIER = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };

function effectivePrice(p) {
  // Splits are already per-invoice amounts — don't multiply
  if (p.billingSplits && p.billingSplits.length > 0) {
    return p.billingSplits.reduce((s, sp) => s + sp.amount, 0);
  }
  // Invoice rows replace the main row
  if (p.invoiceRows && p.invoiceRows.length > 0) {
    return p.invoiceRows.reduce((s, r) => s + (r.unitPrice || 0) * (r.quantity || 1), 0);
  }
  const multiplier = INTERVAL_MULTIPLIER[p.billingInterval] || 1;
  return (p.monthlyPrice || 0) * multiplier;
}

/**
 * Check if a project is due for invoicing in a given month.
 * If nextInvoiceMonth is set, the project is only due when viewMonth >= nextInvoiceMonth
 * AND the month aligns with the billing interval cycle.
 * If not set, it's always due (backwards compatible).
 */
function isDueForMonth(project, monthStart) {
  if (!project.nextInvoiceMonth) return true; // no schedule set = always due
  const next = new Date(project.nextInvoiceMonth);
  const nextY = next.getFullYear(), nextM = next.getMonth();
  const viewY = monthStart.getFullYear(), viewM = monthStart.getMonth();

  // Not yet reached the first invoice month
  if (viewY < nextY || (viewY === nextY && viewM < nextM)) return false;

  // Check if this month aligns with the billing cycle
  const intMonths = INTERVAL_MULTIPLIER[project.billingInterval] || 1;
  const diff = (viewY - nextY) * 12 + (viewM - nextM);
  return diff % intMonths === 0;
}

/**
 * Fiscal year runs Oct–Sep. year=2025 means Oct 2024 – Sep 2025.
 * fyIndex: 0=Oct, 1=Nov, 2=Dec, 3=Jan, 4=Feb, ..., 11=Sep
 */
function fyCalendar(year, fyIndex) {
  const calMonth = (9 + fyIndex) % 12;
  const calYear = fyIndex < 3 ? year - 1 : year;
  return { calYear, calMonth };
}

module.exports = { INTERVAL_MULTIPLIER, effectivePrice, isDueForMonth, fyCalendar };
