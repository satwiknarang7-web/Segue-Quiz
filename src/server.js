import fs from 'node:fs';
import http from 'node:http';

import { handleRequest } from './app.js';
import { config, isHostedDeployment, resolveBaseUrl, usesHttps } from './config.js';
import { accountService } from './services/accountService.js';
import { initialiseStores, storageBackend } from './store/index.js';

fs.mkdirSync(config.dataDir, { recursive: true });

// Supabase-backed tables have to be read before the first request arrives.
let loadedRows = {};
try {
  ({ loaded: loadedRows } = await initialiseStores());
} catch (error) {
  console.error('');
  console.error('  Could not start with the configured storage.');
  console.error(`  ${error.message}`);

  // Name the actual remedy rather than repeating the generic settings advice.
  if (/PGRST205|Could not find the table/i.test(error.message)) {
    console.error('');
    console.error('  Supabase answered, so the URL and key are right - the tables are missing.');
    console.error('  Run supabase/migrations/0001_initial_schema.sql in the SQL editor of your');
    console.error('  Supabase project, then redeploy.');
  } else if (/401|invalid|JWT|apikey/i.test(error.message)) {
    console.error('');
    console.error('  That looks like a rejected key. SUPABASE_SERVICE_ROLE_KEY must be the');
    console.error('  service_role key, not the anon or publishable one.');
  } else {
    console.error('  Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or unset both to use JSON files.');
  }

  console.error('');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[fatal] unhandled request failure', error);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"Something went wrong on the server."}');
    }
  });
});

server.listen(config.port, config.host, () => {
  const baseUrl = resolveBaseUrl();
  const { signupCode, fromEnvironment, open } = accountService.describeSignupCode();

  console.log('');
  console.log('  SegueQuiz is running');
  if (storageBackend() === 'supabase') {
    const counts = Object.entries(loadedRows)
      .map(([table, rows]) => `${rows} ${table}`)
      .join(', ');
    console.log(`  Storage:      Supabase (${counts || 'empty'})`);
  } else {
    console.log(`  Storage:      JSON files in ${config.dataDir}`);
  }
  console.log(`  Organiser:    http://localhost:${config.port}`);
  console.log(`  Participants: ${baseUrl}`);
  if (!config.publicBaseUrl && baseUrl.includes('localhost')) {
    console.log('  (No LAN address found - set PUBLIC_BASE_URL if phones cannot reach this machine.)');
  }
  console.log('');
  // On a hosting platform the defaults that make local use easy become traps.
  if (isHostedDeployment()) {
    const warnings = [];

    if (storageBackend() !== 'supabase') {
      warnings.push([
        'Storage is JSON files on a hosted container.',
        'Every redeploy or restart wipes quizzes, accounts and results.',
        'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      ]);
    }

    if (!accountService.describeSignupCode().sessionSecretFromEnvironment) {
      warnings.push([
        'SEGUEQUIZ_SESSION_SECRET is not set.',
        'A new signing key is generated on every restart, which signs every maker out.',
        'Set it to a long random string.',
      ]);
    }

    if (!usesHttps()) {
      warnings.push([
        'This deployment is not serving over HTTPS.',
        'Passwords and one-time codes would cross the network in the clear.',
      ]);
    }

    for (const [headline, ...detail] of warnings) {
      console.warn(`  ! ${headline}`);
      for (const line of detail) console.warn(`      ${line}`);
    }
    if (warnings.length) console.log('');
  }

  if (open) {
    console.log('  Sign-up is OPEN - anyone who can reach this server can register as a maker.');
  } else {
    console.log(`  Maker sign-up code: ${signupCode}`);
    console.log(
      fromEnvironment
        ? '  (from SEGUEQUIZ_SIGNUP_CODE)'
        : '  Needed once, to register a quiz maker account. Quiz takers never need it.',
    );
  }
  console.log('');
});

const shutdown = (signal) => {
  console.log(`\n[${signal}] shutting down`);
  server.close(() => process.exit(0));
  // Do not hang forever on keep-alive connections.
  setTimeout(() => process.exit(0), 3_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
