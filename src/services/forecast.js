const { PrismaClient } = require('../generated/prisma');
const { effectivePrice, isDueForMonth, fyCalendar } = require('../utils/billing');

const prisma = new PrismaClient();

// Map project category to service_revenue key
function categoryToSrKey(category) {
  if (category === 'Din Marknadskoordinator') return 'dima';
  if (category === 'Supportavtal') return 'supportavtal';
  if (category === 'Webbhotell & domän') return 'hemsidor';
  return 'tjanster';
}

/**
 * Calculate forecast revenue per month per service category for a fiscal year.
 * Returns Array[12] where each element is { dima, supportavtal, hemsidor, tjanster, varor, layout } in SEK.
 */
async function calculateForecast(year) {
  const projects = await prisma.project.findMany({
    where: { isCompleted: false },
    include: { billingSplits: true, invoiceRows: true, priceOverrides: true },
  });

  const forecast = Array.from({ length: 12 }, () => ({
    dima: 0, supportavtal: 0, hemsidor: 0, tjanster: 0, varor: 0, layout: 0,
  }));

  for (let i = 0; i < 12; i++) {
    const { calYear, calMonth } = fyCalendar(year, i);
    const monthStart = new Date(calYear, calMonth, 1);

    for (const p of projects) {
      // Skip paused projects
      if (p.pauseFrom && p.pauseUntil) {
        const from = new Date(p.pauseFrom);
        const until = new Date(p.pauseUntil);
        if (monthStart >= from && monthStart <= until) continue;
      }

      // Skip projects that have ended
      if (p.endDate && monthStart > new Date(p.endDate)) continue;

      // Skip projects not due this month
      if (!isDueForMonth(p, monthStart)) continue;

      // Check for price override for this month
      const override = p.priceOverrides.find(o => {
        const om = new Date(o.month);
        return om.getFullYear() === calYear && om.getMonth() === calMonth;
      });

      const amount = override ? override.price : effectivePrice(p);
      if (!amount) continue;

      const srKey = categoryToSrKey(p.category);
      forecast[i][srKey] += amount;
    }
  }

  return forecast;
}

module.exports = { calculateForecast };
