// `npm run dev`: like `npm start`, but with no DATABASE_URL set it uses a throwaway in-memory
// database instead of refusing to start. The server still prints a warning saying so.
import { IN_MEMORY_DATABASE_URL } from './config.js';

process.env.DATABASE_URL ||= IN_MEMORY_DATABASE_URL;
// Webhooks may reach a receiver on this machine while developing (services/webhookTargets.ts).
process.env.WEBHOOK_ALLOW_LOCAL ||= 'true';
await import('./server.js');
