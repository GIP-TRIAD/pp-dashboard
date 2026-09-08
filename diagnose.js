// scripts/diagnose.js
// Dumps raw commit facts for ONE repo so we can see what's actually
// happening, instead of guessing. Doesn't touch data.json.
//
// Usage: GH_TOKEN=xxx node diagnose.js <student-slug>
// Example: GH_TOKEN=xxx node diagnose.js bino

const https = require('https');
const fs    = require('fs');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const token  = process.env.GH_TOKEN;
const ORG    = config.org;
const PREFIX = config.repo_prefix;
const slug   = process.argv[2];

if (!token) { console.error('GH_TOKEN is not set.'); process.exit(1); }
if (!slug)  { console.error('Usage: node diagnose.js <student-slug>'); process.exit(1); }

function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent':    'writing-dashboard-diagnose',
        'Accept':        'application/vnd.github+json'
      }
    };
    let body = '';
    const req = https.get(options, res => {
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(body), status: res.statusCode }); }
        catch (e) { reject(new Error(`JSON parse error on ${path}: ${body.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
  });
}

async function githubGetAll(path) {
  let results = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const { data, status } = await githubGet(`${path}${sep}per_page=100&page=${page}`);
    if (status !== 200) {
      console.error(`  ! HTTP ${status} on page ${page}:`, JSON.stringify(data).slice(0, 300));
      break;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    results = results.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

async function main() {
  const fullName = `${ORG}/${PREFIX}${slug}`;
  console.log(`\n=== Repo: ${fullName} ===\n`);

  const { data: repoData, status: repoStatus } = await githubGet(`/repos/${fullName}`);
  if (repoStatus !== 200) {
    console.error(`Could not fetch repo (HTTP ${repoStatus}):`, repoData?.message);
    process.exit(1);
  }
  console.log('repo.created_at:      ', repoData.created_at);
  console.log('repo.pushed_at:       ', repoData.pushed_at);
  console.log('repo.default_branch:  ', repoData.default_branch);
  console.log('repo.fork:            ', repoData.fork);
  console.log('repo.template_repository:', repoData.template_repository ? repoData.template_repository.full_name : null);

  const allCommits = await githubGetAll(`/repos/${fullName}/commits`);
  console.log(`\nTotal commits returned: ${allCommits.length}\n`);
  console.log('(newest first, as returned by the API)\n');

  allCommits.forEach((c, i) => {
    const msg = (c.commit?.message || '').split('\n')[0];
    console.log(
      `[${i}] sha=${c.sha.slice(0, 8)}  ` +
      `author_date=${c.commit?.author?.date}  ` +
      `committer_date=${c.commit?.committer?.date}  ` +
      `parents=${(c.parents || []).length}  ` +
      `author_login=${c.author?.login || '(none)'}  ` +
      `msg="${msg}"`
    );
  });

  console.log('\n=== end ===\n');
}

main().catch(e => { console.error(e); process.exit(1); });
