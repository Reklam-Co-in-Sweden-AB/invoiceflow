const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  // Admin user
  const passwordHash = await bcrypt.hash('admin', 10);
  await prisma.user.upsert({
    where: { email: 'oliver@fakturaflode.se' },
    update: {},
    create: {
      email: 'oliver@fakturaflode.se',
      passwordHash,
      name: 'Oliver Atterflod',
    },
  });

  // Articles
  const articles = [
    { articleNumber: '101', name: 'Din Marknadskoordinator', serviceType: 'marknadskoordinator', defaultPrice: 6500, vatRate: 25 },
    { articleNumber: '103', name: 'Din Marknadskoordinator Plus', serviceType: 'marknadskoordinator', defaultPrice: 25000, vatRate: 25 },
    { articleNumber: '108', name: 'Supportavtal-Small', serviceType: 'supportavtal', defaultPrice: 349, vatRate: 25 },
    { articleNumber: '211', name: 'AI Översättning', serviceType: 'supportavtal', defaultPrice: 200, vatRate: 25 },
    { articleNumber: '2101', name: 'Cookiebot', serviceType: 'supportavtal', defaultPrice: 150, vatRate: 25 },
  ];

  for (const art of articles) {
    await prisma.article.upsert({
      where: { articleNumber: art.articleNumber },
      update: { name: art.name, serviceType: art.serviceType, defaultPrice: art.defaultPrice, vatRate: art.vatRate },
      create: art,
    });
  }

  console.log('Seed complete: 1 user, %d articles', articles.length);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
