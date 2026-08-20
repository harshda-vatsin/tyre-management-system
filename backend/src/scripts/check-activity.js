/**
 * @file check-activity.js
 * @description CLI script to query the database and summarize website usage,
 * user logins, audit events, and MIS uploads to check if the client is testing the system.
 * Run via: node src/scripts/check-activity.js
 */

require('dotenv').config();
const db = require('../db');

// ANSI escape codes for formatting
const RESET = '\x1b[0m';
const BRIGHT = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function getUtcString(date) {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

function getUtcDateAgoString(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return getUtcString(d);
}

function formatDuration(dateStr) {
  if (!dateStr) return 'never';
  try {
    const past = new Date(dateStr.replace(' ', 'T') + 'Z');
    const diffMs = Date.now() - past.getTime();
    if (isNaN(diffMs) || diffMs < 0) return 'just now';
    
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'less than a minute ago';
    if (mins < 60) return `${mins} min(s) ago`;
    
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour(s) ago`;
    
    const days = Math.floor(hours / 24);
    return `${days} day(s) ago`;
  } catch (e) {
    return 'unknown';
  }
}

async function main() {
  console.log(`${BRIGHT}Connecting to database and compiling activity report...${RESET}\n`);
  
  // Wait for schema/db init
  await db.ready;

  const nowString = getUtcString(new Date());
  const oneDayAgo = getUtcDateAgoString(1);
  const sevenDaysAgo = getUtcDateAgoString(7);
  const thirtyDaysAgo = getUtcDateAgoString(30);

  // 1. Fetch Summary Timestamps
  const lastRequest = await db.prepare('SELECT MAX(created_at) as m FROM access_logs').get();
  const lastAudit = await db.prepare('SELECT MAX(created_at) as m FROM audit_log').get();
  const lastUpload = await db.prepare('SELECT MAX(started_at) as m FROM import_sessions').get();
  const lastLogin = await db.prepare('SELECT MAX(last_login) as m FROM users').get();

  const reqTime = lastRequest?.m || null;
  const auditTime = lastAudit?.m || null;
  const uploadTime = lastUpload?.m || null;
  const loginTime = lastLogin?.m || null;

  // Determine overall latest activity
  let latestActivityTime = null;
  let latestActivityType = 'None';

  const dates = [
    { time: reqTime, type: 'Web Traffic (Page view/API call)' },
    { time: auditTime, type: 'Data Change (Audit log)' },
    { time: uploadTime, type: 'MIS Excel Import' },
    { time: loginTime, type: 'User Login' }
  ];

  for (const d of dates) {
    if (d.time) {
      if (!latestActivityTime || d.time > latestActivityTime) {
        latestActivityTime = d.time;
        latestActivityType = d.type;
      }
    }
  }

  // Determine Verdict
  let verdictColor = RED;
  let verdictText = 'INACTIVE (No recent testing found)';
  
  if (latestActivityTime) {
    const diffMs = Date.now() - new Date(latestActivityTime.replace(' ', 'T') + 'Z').getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours <= 24) {
      verdictColor = GREEN;
      verdictText = 'ACTIVE (Client is currently testing!)';
    } else if (diffHours <= 7 * 24) {
      verdictColor = GREEN;
      verdictText = 'TESTED RECENTLY (Client active within the last week)';
    } else if (diffHours <= 30 * 24) {
      verdictColor = YELLOW;
      verdictText = 'SLUGGISH (Tested in the last 30 days, but inactive now)';
    }
  }

  // 2. Fetch traffic volume stats
  const count24h = (await db.prepare('SELECT COUNT(*) c FROM access_logs WHERE created_at >= ?').get(oneDayAgo)).c;
  const count7d = (await db.prepare('SELECT COUNT(*) c FROM access_logs WHERE created_at >= ?').get(sevenDaysAgo)).c;
  const count30d = (await db.prepare('SELECT COUNT(*) c FROM access_logs WHERE created_at >= ?').get(thirtyDaysAgo)).c;

  // Top endpoints (last 7 days)
  const topEndpoints = await db.prepare(`
    SELECT path, COUNT(*) c, ROUND(AVG(response_time_ms)) lat
    FROM access_logs
    WHERE created_at >= ?
    GROUP BY path
    ORDER BY c DESC
    LIMIT 5
  `).all(sevenDaysAgo);

  // Top active users (last 7 days)
  const topTrafficUsers = await db.prepare(`
    SELECT COALESCE(username, 'Anonymous') u, COALESCE(role, 'Anonymous') role, COUNT(*) c
    FROM access_logs
    WHERE created_at >= ?
    GROUP BY username, role
    ORDER BY c DESC
    LIMIT 5
  `).all(sevenDaysAgo);

  // 3. User Login List
  const userLogins = await db.prepare(`
    SELECT username, role, last_login
    FROM users
    ORDER BY last_login DESC NULLS LAST
  `).all();

  // 4. Recent Audit Logs
  const recentAudits = await db.prepare(`
    SELECT username, action, entity_type, entity_id, created_at
    FROM audit_log
    ORDER BY created_at DESC, id DESC
    LIMIT 5
  `).all();

  // 5. Recent Imports
  const recentImports = await db.prepare(`
    SELECT u.username, s.original_filename, s.status, s.started_at, s.rows_total
    FROM import_sessions s
    LEFT JOIN users u ON s.uploaded_by = u.id
    ORDER BY s.started_at DESC
    LIMIT 3
  `).all();

  // 6. Recent Requests Details
  const recentRequests = await db.prepare(`
    SELECT COALESCE(username, 'Anonymous') u, method, path, status_code, response_time_ms, created_at
    FROM access_logs
    ORDER BY created_at DESC, id DESC
    LIMIT 10
  `).all();

  // PRINT THE REPORT
  console.log('======================================================================');
  console.log(`                 ${BRIGHT}EBTMS CLIENT ACTIVITY REPORT${RESET}`);
  console.log('======================================================================');
  console.log(`Current Time (UTC): ${CYAN}${nowString}${RESET}`);
  console.log(`Verdict:           ${verdictColor}${BRIGHT}${verdictText}${RESET}`);
  console.log('----------------------------------------------------------------------');
  console.log(`${BRIGHT}1. TIMING SUMMARY${RESET}`);
  console.log('----------------------------------------------------------------------');
  console.log(`Last Web Request:     ${reqTime ? `${CYAN}${reqTime}${RESET} (${formatDuration(reqTime)})` : 'Never'}`);
  console.log(`Last User Login:      ${loginTime ? `${CYAN}${loginTime}${RESET} (${formatDuration(loginTime)})` : 'Never'}`);
  console.log(`Last Audit Event:     ${auditTime ? `${CYAN}${auditTime}${RESET} (${formatDuration(auditTime)})` : 'Never'}`);
  console.log(`Last Excel Upload:    ${uploadTime ? `${CYAN}${uploadTime}${RESET} (${formatDuration(uploadTime)})` : 'Never'}`);
  console.log(`Latest System Event:  ${latestActivityTime ? `${GREEN}${latestActivityTime}${RESET} (${formatDuration(latestActivityTime)})` : 'Never'}`);
  console.log(`Latest Event Type:    ${latestActivityTime ? `${GREEN}${latestActivityType}${RESET}` : 'None'}`);
  console.log('----------------------------------------------------------------------');
  console.log(`${BRIGHT}2. WEB TRAFFIC STATISTICS (Access Logs)${RESET}`);
  console.log('----------------------------------------------------------------------');
  console.log(`Total web requests logged:`);
  console.log(`  - Last 24 Hours:  ${count24h > 0 ? GREEN : RESET}${count24h}${RESET}`);
  console.log(`  - Last 7 Days:    ${count7d > 0 ? GREEN : RESET}${count7d}${RESET}`);
  console.log(`  - Last 30 Days:   ${count30d > 0 ? GREEN : RESET}${count30d}${RESET}`);
  console.log();
  console.log(`Top Visited Endpoints (Last 7 Days):`);
  if (topEndpoints.length === 0) {
    console.log('  No requests recorded in the last 7 days.');
  } else {
    topEndpoints.forEach(e => {
      console.log(`  - ${CYAN}${e.path.padEnd(35)}${RESET} | Requests: ${GREEN}${String(e.c).padEnd(4)}${RESET} | Avg Latency: ${e.lat}ms`);
    });
  }
  console.log();
  console.log(`Top Active Users (Last 7 Days):`);
  if (topTrafficUsers.length === 0) {
    console.log('  No user traffic recorded in the last 7 days.');
  } else {
    topTrafficUsers.forEach(u => {
      console.log(`  - ${CYAN}${u.u.padEnd(15)}${RESET} (${u.role.padEnd(22)}) | Requests: ${GREEN}${u.c}${RESET}`);
    });
  }
  console.log('----------------------------------------------------------------------');
  console.log(`${BRIGHT}3. USER REGISTERED LOGINS${RESET}`);
  console.log('----------------------------------------------------------------------');
  console.log(`${BRIGHT}${'Username'.padEnd(12)} | ${'Role'.padEnd(25)} | ${'Last Login (UTC)'.padEnd(19)} | ${'Time Elapsed'}${RESET}`);
  console.log('----------------------------------------------------------------------');
  userLogins.forEach(u => {
    console.log(`${u.username.padEnd(12)} | ${u.role.padEnd(25)} | ${(u.last_login || 'Never').padEnd(19)} | ${formatDuration(u.last_login)}`);
  });
  console.log('----------------------------------------------------------------------');
  console.log(`${BRIGHT}4. RECENT SYSTEM CHANGES (Audit Log - Last 5)${RESET}`);
  console.log('----------------------------------------------------------------------');
  if (recentAudits.length === 0) {
    console.log('No system modifications recorded in the audit log.');
  } else {
    console.log(`${BRIGHT}${'Time (UTC)'.padEnd(19)} | ${'User'.padEnd(10)} | ${'Action'.padEnd(10)} | ${'Entity Type'.padEnd(15)} | ${'Ref ID'}${RESET}`);
    console.log('----------------------------------------------------------------------');
    recentAudits.forEach(a => {
      console.log(`${a.created_at} | ${(a.username || 'system').padEnd(10)} | ${a.action.padEnd(10)} | ${a.entity_type.padEnd(15)} | #${a.entity_id || '-'}`);
    });
  }
  console.log('----------------------------------------------------------------------');
  console.log(`${BRIGHT}5. RECENT EXCEL UPLOADS (MIS Imports - Last 3)${RESET}`);
  console.log('----------------------------------------------------------------------');
  if (recentImports.length === 0) {
    console.log('No MIS Excel upload logs found.');
  } else {
    console.log(`${BRIGHT}${'Time (UTC)'.padEnd(19)} | ${'User'.padEnd(10)} | ${'Filename'.padEnd(20)} | ${'Status'.padEnd(10)} | ${'Rows'}${RESET}`);
    console.log('----------------------------------------------------------------------');
    recentImports.forEach(i => {
      const filename = i.original_filename.length > 20 ? i.original_filename.substring(0, 17) + '...' : i.original_filename;
      console.log(`${i.started_at} | ${(i.username || 'unknown').padEnd(10)} | ${filename.padEnd(20)} | ${i.status.padEnd(10)} | ${i.rows_total}`);
    });
  }
  console.log('----------------------------------------------------------------------');
  console.log(`${BRIGHT}6. RECENT WEB PATHS ACCESSED (Last 10 Web Requests)${RESET}`);
  console.log('----------------------------------------------------------------------');
  if (recentRequests.length === 0) {
    console.log('No web requests recorded in the access log yet.');
  } else {
    console.log(`${BRIGHT}${'Time (UTC)'.padEnd(19)} | ${'User'.padEnd(10)} | ${'Method'.padEnd(6)} | ${'Path'.padEnd(25)} | ${'Status'.padEnd(6)} | ${'Latency'}${RESET}`);
    console.log('----------------------------------------------------------------------');
    recentRequests.forEach(r => {
      const path = r.path.length > 25 ? r.path.substring(0, 22) + '...' : r.path;
      const statusColor = r.status_code >= 400 ? RED : r.status_code >= 300 ? YELLOW : GREEN;
      console.log(`${r.created_at} | ${r.u.padEnd(10)} | ${r.method.padEnd(6)} | ${path.padEnd(25)} | ${statusColor}${String(r.status_code).padEnd(6)}${RESET} | ${r.response_time_ms}ms`);
    });
  }
  console.log('======================================================================');

  await db.close();
}

main().catch(err => {
  console.error('Error running activity check:', err);
  process.exit(1);
});
