import { readFile, writeFile } from 'node:fs/promises';
const value = process.argv[2];
if (!value) throw new Error('Usage: npm run configure:backend -- https://YOUR_BACKEND');
const url = new URL(value);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Backend must use HTTPS, without credentials, query or fragment.');
const base = url.href.replace(/\/$/, '');
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
config.rewrites = [{ source: '/api/:path*', destination: base + '/api/:path*' }, ...(config.rewrites || []).filter(rule => rule.source !== '/api/:path*')];
config.headers = [
  { source: '/(.*)', headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' }
  ] }
];
await writeFile('vercel.json', JSON.stringify(config, null, 2) + '\n');
console.log('Vercel API proxy configured for ' + base + '. Deploy using vercel --prod.');
