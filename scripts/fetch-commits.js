// scripts/fetch-commits.js
// Discovers all pp-student-* repos in the org, fetches commit data for each,
// and writes data.json for the dashboard.
// Requires: GH_TOKEN env var (read access to org repos).

const https = require('https');
const fs    = require('fs');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const token  = process.env.GH_TOKEN;
const ORG    = config.org;         // "GIP-TRIAD"
const PREFIX = config.repo_prefix; // "pp-student-"

if (!token) {
  console.error('GH_TOKEN is not set.');
  process.exit(1);
}

// ── GitHub API helper ────────────────────────────────────────────────────────

function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent':    'writing-dashboard',
        'Accept':        'application/vnd.github+json'
      }
    };
    let body = '';
    const req = https.get(options, res => {
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(body), headers: res.headers }); }
        catch (e) { reject(new Error(`JSON parse error on ${path}: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
  });
}

/** Fetch all pages of a list endpoint. */
async function githubGetAll(path) {
  let results = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const { data } = await githubGet(`${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results = results.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ── Repo discovery ────────────────────────────────────────────────────────────

async function discoverStudentRepos() {
  console.log(`Discovering repos with prefix "${PREFIX}" in org "${ORG}"…`);
  const repos = await githubGetAll(`/orgs/${ORG}/repos?type=all`);
  return repos
    .filter(r => r.name.startsWith(PREFIX))
    .map(r => `${r.owner.login}/${r.name}`);
}

// ── Commit helpers (unchanged from original) ──────────────────────────────────

async function fetchAllCommits(repo) {
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceStr = since.toISOString();

  let page = 1;
  let all = [];
  while (true) {
    const path = `/repos/${repo}/commits?since=${sinceStr}&per_page=100&page=${page}`;
    const { data: commits } = await githubGet(path);
    if (!Array.isArray(commits) || commits.length === 0) break;
    all = all.concat(commits);
    if (commits.length < 100) break;
    page++;
  }
  return all;
}

function toDailyMap(commits) {
  const map = {};
  for (const c of commits) {
    const date = (c.commit?.author?.date || '').slice(0, 10);
    if (date) map[date] = (map[date] || 0) + 1;
  }
  return map;
}

function activeDays(dailyMap) {
  return Object.keys(dailyMap).sort();
}

function calcGaps(days) {
  const gaps = [];
  for (let i = 1; i < days.length; i++) {
    const diff = (new Date(days[i]) - new Date(days[i - 1])) / 86400000;
    gaps.push(Math.round(diff));
  }
  return gaps;
}

function calcAvgGap(gaps) {
  if (gaps.length === 0) return 0;
  return Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10;
}

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

function calcCommits30(dailyMap) {
  const today = new Date();
  let total = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    total += dailyMap[d.toISOString().slice(0, 10)] || 0;
  }
  return total;
}

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

// ── Display name resolution ───────────────────────────────────────────────────

function buildSlugMap() {
  const map = {};
  for (const s of config.students || []) {
    map[s.slug] = s.name;
  }
  return map;
}

function displayName(repoFullName, slugMap) {
  const slug = repoFullName.split('/')[1].replace(PREFIX, '');
  if (slugMap[slug]) return slugMap[slug];
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const repos   = await discoverStudentRepos();
  const slugMap = buildSlugMap();
  console.log(`Found ${repos.length} student repo(s).`);

  const output = {
    generated_at: new Date().toISOString(),
    title:    config.title,
    semester: config.semester,
    students: []
  };

  for (const repo of repos) {
    const name = displayName(repo, slugMap);
    console.log(`Fetching: ${repo}`);
    try {
      const commits    = await fetchAllCommits(repo);
      const dailyMap   = toDailyMap(commits);
      const days       = activeDays(dailyMap);
      const gaps       = calcGaps(days.slice(1));
      const last30     = calcLast30(dailyMap);
      const lastCommit = days.slice(-1)[0] || null;
      const daysSinceLast = lastCommit
        ? Math.floor((new Date() - new Date(lastCommit)) / 86400000)
        : 999;

      // avatar_url lives on c.author (GitHub user object), not c.commit.author (git metadata)
      // display the avatar of the most frequent author
      const avatarCounts = {};
      for (const c of commits) {
        const url = c.author?.avatar_url;
        if (url) avatarCounts[url] = (avatarCounts[url] || 0) + 1;
      }
      const avatarUrl = Object.entries(avatarCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      output.students.push({
        name,
        avatar_url:      avatarUrl,
        active_days:     days,
        gaps,
        avg_gap:         calcAvgGap(gaps),
        current_streak:  calcStreak(dailyMap),
        commits_30:      calcCommits30(dailyMap),
        last30,
        last_commit:     lastCommit,
        days_since_last: daysSinceLast
      });

    } catch (err) {
      console.error(`Error fetching ${repo}: ${err.message}`);
      output.students.push({
        name,
        error:           err.message,
        active_days:     [],
        gaps:            [],
        avg_gap:         0,
        current_streak:  0,
        commits_30:      0,
        last30:          [],
        last_commit:     null,
        days_since_last: 999
      });
    }
  }

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`data.json written with ${output.students.length} students.`);
}

main().catch(e => { console.error(e); process.exit(1); });