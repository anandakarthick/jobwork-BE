import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { failInterruptedIngestJobs } from './modules/price-list/price-list.service';
import { failInterruptedTextJobs } from './modules/price-list/price-list.text';
import { failInterruptedClaudeTraining } from './modules/companies/knowledge.service';

async function main() {
  await prisma.$connect();
  // Background jobs don't survive a restart — flag any that were mid-flight.
  await Promise.all([failInterruptedTextJobs(), failInterruptedIngestJobs(), failInterruptedClaudeTraining()]);

  const server = createApp().listen(env.port, () => {
    console.log(`[jobwork-api] listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[jobwork-api] ${signal} received, shutting down`);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('[jobwork-api] failed to start', err);
  await prisma.$disconnect();
  process.exit(1);
});
