// Test-only server. Email codes remain in a local fixture file, never in production APIs.
import { writeFile } from 'node:fs/promises';
import { createApp } from '../server/app.mjs';
const messages = [];
const { app, db } = createApp({ mailer: { async sendCode(email, code) { messages.push({ email, code }); await writeFile('/tmp/catalina-browser-mail.json', JSON.stringify(messages), { mode: 0o600 }); } } });
const server = app.listen(3000, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
