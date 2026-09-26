// scripts/notify-inactive.js
//
// Reads data.json (already refreshed by fetch-commits.js earlier in the
// workflow) and, for any student who has gone quiet for too long, opens an
// issue in *their own* repo nudging them. Re-running this daily won't spam
// students: it looks for an already-open nudge issue (by label) before
// creating a new one, and closes that issue automatically once the student
// commits again.
//
// data.json has no explicit GitHub-username field, only `name` and
// `avatar_url` (which embeds the student's numeric GitHub user id, e.g.
// ".../u/284227068"). To get a real @mention, this script resolves that id
// to a login via GET /user/{id} before opening each issue.

const fs = require('fs');

const GH_TOKEN = process.env.GH_TOKEN;
const THRESHOLD_DAYS = Number(process.env.INACTIVITY_THRESHOLD_DAYS || 10);
const NUDGE_LABEL = 'inactivity-nudge';

if (!GH_TOKEN) {
  console.error('GH_TOKEN is not set.');
  process.exit(1);
}

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`GitHub API ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res.status === 404 ? null : res.json();
}

function parseOwnerRepo(repoUrl) {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`Could not parse owner/repo from ${repoUrl}`);
  return { owner: m[1], repo: m[2] };
}

function parseUserId(avatarUrl) {
  const m = avatarUrl && avatarUrl.match(/\/u\/(\d+)/);
  return m ? m[1] : null;
}

async function resolveUsername(avatarUrl) {
  const id = parseUserId(avatarUrl);
  if (!id) return null;
  const user = await gh(`/user/${id}`);
  return user ? user.login : null;
}

async function findOpenNudge(owner, repo) {
  const issues = await gh(
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(NUDGE_LABEL)}`
  );
  return issues && issues.length ? issues[0] : null;
}

function nudgeBody(student, username) {
  const who = username ? `@${username}` : student.name;
  return [
    `Hello ${who}, it's been **${student.days_since_last} days** since your last commit.`,
    '',
    `_This issue was opened automatically and will close itself once a new commit is detected._`,
  ].join('\n');
}

async function ensureLabelExists(owner, repo) {
  const label = await gh(`/repos/${owner}/${repo}/labels/${NUDGE_LABEL}`);
  if (!label) {
    await gh(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name: NUDGE_LABEL, color: 'D93F0B', description: 'Automated inactivity nudge' }),
    });
  }
}

async function main() {
  const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
  const students = Array.isArray(data) ? data : data.students;

  for (const student of students) {
    if (student.error || student.last_commit === null || !student.repo_url) continue;

    const { owner, repo } = parseOwnerRepo(student.repo_url);
    const isInactive = student.days_since_last >= THRESHOLD_DAYS;
    const existingNudge = await findOpenNudge(owner, repo);

    if (isInactive && !existingNudge) {
      const username = await resolveUsername(student.avatar_url);
      await ensureLabelExists(owner, repo);
      await gh(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title: `Inactivity check-in: ${student.days_since_last} days since last commit`,
          body: nudgeBody(student, username),
          labels: [NUDGE_LABEL],
        }),
      });
      console.log(`Opened nudge for ${student.name} (${owner}/${repo})`);
    } else if (!isInactive && existingNudge) {
      await gh(`/repos/${owner}/${repo}/issues/${existingNudge.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: '🎉 New commit detected — closing this out.' }),
      });
      await gh(`/repos/${owner}/${repo}/issues/${existingNudge.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      });
      console.log(`Closed nudge for ${student.name} (${owner}/${repo})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
