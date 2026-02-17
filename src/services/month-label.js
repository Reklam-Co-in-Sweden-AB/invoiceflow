const MONTHS_SV = [
  'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
];

/**
 * Generate a Swedish month label from a date.
 * E.g. "Mars 2026"
 */
function getMonthLabel(date) {
  const d = new Date(date);
  return `${MONTHS_SV[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Calculate the invoice month (first of month) from fromDate/toDate.
 * Uses the midpoint of the period.
 */
function getInvoiceMonth(fromDate, toDate) {
  const from = new Date(fromDate);
  const to = toDate ? new Date(toDate) : from;
  const mid = new Date((from.getTime() + to.getTime()) / 2);
  return new Date(mid.getFullYear(), mid.getMonth(), 1);
}

/**
 * Append month label to a text string.
 * "Supportavtal-Small" → "Supportavtal-Small — Mars 2026"
 */
function appendMonthLabel(text, monthLabel) {
  // Don't double-append
  if (text.includes(' — ') && text.includes(monthLabel)) return text;
  return `${text} — ${monthLabel}`;
}

module.exports = { getMonthLabel, getInvoiceMonth, appendMonthLabel, MONTHS_SV };
