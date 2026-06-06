const https = require('https');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const token = process.env.GH_TOKEN;

function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'writing-dashboard',
        'Accept': 'application/vnd.github+json'
      }
    };
    let body = '';
    const req = https.get(options, res => {
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error on ${path}: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
  });
}

// Fetch all commits for a repo going back 90 days (project duration)
async function fetchAllCommits(repo) {
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceStr = since.toISOString();

  let page = 1;
  let all = [];
  while (true) {
    const path = `/repos/${repo}/commits?since=${sinceStr}&per_page=100&page=${page}`;
    const commits = await githubGet(path);
    if (!Array.isArray(commits) || commits.length === 0) break;
    all = all.concat(commits);
    if (commits.length < 100) break;
    page++;
  }
  return all;
}

// Reduce commits to a map of { 'YYYY-MM-DD': count }
function toDailyMap(commits) {
  const map = {};
  for (const c of commits) {
    const date = (c.commit?.author?.date || '').slice(0, 10);
    if (date) map[date] = (map[date] || 0) + 1;
  }
  return map;
}

// Sorted list of unique days that have at least one commit
function activeDays(dailyMap) {
  return Object.keys(dailyMap).sort();
}

// Gaps in days between consecutive active days
function calcGaps(days) {
  const gaps = [];
  for (let i = 1; i < days.length; i++) {
    const diff = (new Date(days[i]) - new Date(days[i - 1])) / 86400000;
    gaps.push(Math.round(diff));
  }
  return gaps;
}

// Average gap between consecutive active days (tiebreaker 3)
function calcAvgGap(gaps) {
  if (gaps.length === 0) return 0;
  return Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10;
}

// Current streak: consecutive days with at least one commit counting back from today
function calcStreak(dailyMap) {
  const today = new Date();
  let streak = 0;
  let d = new Date(today);
  while (true) {
    const key = d.toISOString().slice(0, 10);
    if (dailyMap[key]) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

// Total commits in the last 30 days (tiebreaker 2)
function calcCommits30(dailyMap) {
  const today = new Date();
  let total = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    total += dailyMap[key] || 0;
  }
  return total;
}

// Last 30 days as array of { date, count } for the activity strip
function calcLast30(dailyMap) {
  const result = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: dailyMap[key] || 0 });
  }
  return result;
}

async function main() {
  const output = {
    generated_at: new Date().toISOString(),
    title: config.title,
    semester: config.semester,
    students: []
  };

  for (const student of config.students) {
    console.log(`Fetching: ${student.repo}`);
    try {
      const commits = await fetchAllCommits(student.repo);
      const dailyMap = toDailyMap(commits);
      const days = activeDays(dailyMap);
      const gaps = calcGaps(days);
      const last30 = calcLast30(dailyMap);
      const lastCommit = days.slice(-1)[0] || null;
      const daysSinceLast = lastCommit
        ? Math.floor((new Date() - new Date(lastCommit)) / 86400000)
        : 999;

      output.students.push({
        name: student.name,
        github_username: student.github_username,
        // raw data the dashboard needs for scoring + display
        active_days: days,          // sorted list of YYYY-MM-DD strings with commits
        gaps,                       // gaps in days between consecutive active days
        avg_gap: calcAvgGap(gaps),  // tiebreaker 3
        current_streak: calcStreak(dailyMap),  // tiebreaker 1
        commits_30: calcCommits30(dailyMap),   // tiebreaker 2
        last30,                     // for the activity strip
        last_commit: lastCommit,
        days_since_last: daysSinceLast
      });

    } catch (err) {
      console.error(`Error fetching ${student.repo}: ${err.message}`);
      output.students.push({
        name: student.name,
        github_username: student.github_username,
        error: err.message,
        active_days: [],
        gaps: [],
        avg_gap: 0,
        current_streak: 0,
        commits_30: 0,
        last30: [],
        last_commit: null,
        days_since_last: 999
      });
    }
  }

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`data.json written with ${output.students.length} students.`);
}

main().catch(e => { console.error(e); process.exit(1); });
