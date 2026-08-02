/**
 * WebEaze Request Bot — Cloudflare Worker
 *
 * Flow:
 *  1. HubSpot Workflow POSTs here when a Website Request form is submitted
 *  2. We look up the client's GitHub repo from CLIENTS_JSON env var
 *  3. Claude reads the relevant files, figures out the change, applies it
 *  4. We open a PR in the client's repo — or a GitHub Issue if it's too complex
 *
 * Required environment secrets (set via `wrangler secret put`):
 *   GITHUB_TOKEN     — fine-grained PAT with Contents + Pull Requests write access
 *   CLAUDE_API_KEY   — Anthropic API key
 *   HUBSPOT_SECRET   — the webhook secret from HubSpot (for signature verification)
 *
 * Required environment vars (in wrangler.toml [vars]):
 *   GITHUB_ORG       — your GitHub username or org, e.g. "webeaze"
 *
 * Required environment vars (set via wrangler secret put or dashboard):
 *   CLIENTS_JSON     — JSON string mapping client email → { repo: "repo-name" }
 *                      e.g. '{"client@business.com":{"repo":"bear-carpet-care"}}'
 */

export default {
  async fetch(request, env, _ctx) {
    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    // Process synchronously and return the real outcome. The edit work is too long-running to
    // survive a background waitUntil on Workers, and the caller (portal / test) wants the result.
    try {
      const outcome = await processRequest(payload, env);
      return json(outcome || { ok: true });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  }
};

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// ---------------------------------------------------------------------------
// Main request processor
// ---------------------------------------------------------------------------

async function processRequest(payload, env) {
  const email = (payload.email || '').toLowerCase().trim();
  const description = payload.request_description || payload.message || payload.content || '';
  const requestType = payload.request_type || 'General update';
  const submittedBy = [payload.firstname, payload.lastname].filter(Boolean).join(' ') || 'Client';

  // Rollback hook: POST {action:'revert', email} undoes the most recent commit on the client's
  // repo default branch. Used by the auto-rollback watchdog and available for manual recovery.
  // This does not need a request description, so it is handled before the description check.
  if (payload.action === 'revert') {
    if (!email) return { ok: false, skipped: 'missing email' };
    let revertClients;
    try {
      revertClients = JSON.parse(env.CLIENTS_JSON || '{}');
    } catch {
      return { ok: false, error: 'CLIENTS_JSON is not valid JSON' };
    }
    const revertClient = revertClients[email];
    if (!revertClient) return { ok: false, skipped: `no client config for ${email}` };
    const revertResult = await revertLastMerge(`${env.GITHUB_ORG}/${revertClient.repo}`, env);
    return revertResult.ok
      ? { ok: true, reverted: true, commit: revertResult.commit, undid: revertResult.reverted }
      : { ok: false, error: revertResult.error };
  }

  if (!email || !description) {
    return { ok: false, skipped: 'missing email or description' };
  }

  // Look up client config
  let clients;
  try {
    clients = JSON.parse(env.CLIENTS_JSON || '{}');
  } catch {
    return { ok: false, error: 'CLIENTS_JSON is not valid JSON' };
  }

  const client = clients[email];
  if (!client) {
    return { ok: false, skipped: `no client config for ${email}` };
  }

  const repoFull = `${env.GITHUB_ORG}/${client.repo}`;
  console.log(`Processing request for ${email} → ${repoFull}`);

  const branchName = `request/${Date.now()}`;

  // Run Claude to determine and stage changes
  const result = await runClaudeAgent({
    repoFull,
    request: { type: requestType, description, submittedBy, email },
    env,
  });

  if (result.escalate || result.changes.length === 0) {
    // Too complex or ambiguous — create a GitHub Issue for manual handling
    const reason = result.reason || 'No confident change could be made automatically.';
    const issue = await createGitHubIssue(repoFull, {
      title: `[Request] ${requestType} — ${submittedBy}`,
      body: formatIssueBody({ submittedBy, email, requestType, description, reason }),
    }, env);
    return { ok: true, escalated: true, reason, issue };
  }

  // Create branch, commit all changes, open PR
  try {
    const pr = await createBranchAndPR(repoFull, branchName, result.changes, {
      title: `[Request] ${requestType} — ${submittedBy}`,
      body: formatPRBody({ submittedBy, email, requestType, description, changes: result.changes }),
    }, env);
    // Opted-in clients (autoMerge:true in CLIENTS_JSON) go live with no human. Everyone else
    // stays a PR for review. A failed merge (conflict/checks) just leaves the PR open.
    let merged = false;
    let reviewBlocked = false;
    let reviewReason = '';
    let summary = '';
    if (client.autoMerge) {
      // Safety gate: before anything goes live unattended, a second Claude call reviews the exact
      // change. If it is not confident the change is safe, we leave the PR open for a human.
      const review = await reviewChanges({
        request: { type: requestType, description },
        changes: result.changes,
        env,
      });
      summary = review.summary;
      if (review.safe) {
        merged = await mergePR(repoFull, pr.number, env);
      } else {
        reviewBlocked = true;
        reviewReason = review.reason;
      }
    }
    const out = { ok: true, pr: pr.url, merged, files: result.changes.map((c) => c.path) };
    if (summary) out.summary = summary;
    if (reviewBlocked) { out.reviewBlocked = true; out.reviewReason = reviewReason; }
    return out;
  } catch (err) {
    // Fall back to a GitHub Issue so the request isn't lost
    const issue = await createGitHubIssue(repoFull, {
      title: `[Request] ${requestType} — ${submittedBy}`,
      body: formatIssueBody({ submittedBy, email, requestType, description, reason: `Auto-PR failed: ${err.message}` }),
    }, env);
    return { ok: false, escalated: true, error: `PR failed: ${err.message}`, issue };
  }
}

// ---------------------------------------------------------------------------
// Claude agentic loop
// ---------------------------------------------------------------------------

async function runClaudeAgent({ repoFull, request, env }) {
  const tools = [
    {
      name: 'list_files',
      description: 'List all HTML and CSS files in the repository root.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'read_file',
      description: 'Read the current content of a file in the repository.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, e.g. index.html or about.html' },
        },
        required: ['path'],
      },
    },
    {
      name: 'edit_file',
      description: 'Make a targeted edit: replace an exact snippet with new text. Provide old_string (copied verbatim from the current file, with enough surrounding context that it appears EXACTLY ONCE) and new_string. Do NOT send the whole file. Call once per distinct edit.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to modify, e.g. index.html' },
          old_string: { type: 'string', description: 'Exact text to find, copied verbatim from the file, unique with surrounding context' },
          new_string: { type: 'string', description: 'Replacement text' },
          summary: { type: 'string', description: 'One sentence: what changed and why' },
        },
        required: ['path', 'old_string', 'new_string', 'summary'],
      },
    },
    {
      name: 'escalate',
      description: 'Use when the request is too complex, ambiguous, needs new features, or you are not confident in the exact change. This routes to a human.',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why this needs manual handling' },
        },
        required: ['reason'],
      },
    },
  ];

  const system = `You are a web developer working for WebEaze, a website management service for small businesses. A client has submitted a website update request and your job is to make that exact change to their HTML files.

Guidelines:
- Only change what the request explicitly asks for. Do not improve, reformat, or touch anything else.
- For simple changes (text, phone number, hours, address, a link, images, colors, adding or removing a small snippet), make the change with edit_file.
- For new functionality, integrations, significant layout restructures, an ambiguous request, or anything you are not fully confident about, call escalate with a clear, specific reason.
- ALWAYS read_file first. Start with list_files if you are unsure which file to edit.
- To edit, call edit_file with old_string (the EXACT text copied verbatim from the current file, including enough surrounding characters that it appears exactly once) and new_string.
- Files can be very large. Only ever send the small snippet you are changing in old_string, never the entire file.
- One edit_file call per distinct change. Call it again for additional changes.`;

  const messages = [
    {
      role: 'user',
      content: `A client submitted this website update request:\n\n**Submitted by:** ${request.submittedBy} (${request.email})\n**Request type:** ${request.type}\n**Description:** ${request.description}\n\nRead the relevant file(s) and make the change. Start by listing files or reading the most likely file based on what the request describes.`,
    },
  ];

  const changes = [];
  let escalateResult = null;

  for (let turn = 0; turn < 12; turn++) {
    const response = await callAnthropic({
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      system,
      tools,
      messages,
    }, env.CLAUDE_API_KEY);

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    let done = false;

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      let result;

      if (block.name === 'list_files') {
        const files = await listRepoFiles(repoFull, env);
        result = { files };

      } else if (block.name === 'read_file') {
        const content = await getFileFromGitHub(repoFull, block.input.path, env);
        result = content !== null
          ? { success: true, content }
          : { success: false, error: `File not found: ${block.input.path}` };

      } else if (block.name === 'edit_file') {
        const { path, old_string, new_string, summary } = block.input;
        const content = await getFileFromGitHub(repoFull, path, env);
        if (content === null) {
          result = { success: false, error: `File not found: ${path}. Use list_files to see available files.` };
        } else {
          const count = content.split(old_string).length - 1;
          if (count === 0) result = { success: false, error: 'old_string not found in the file. Read the file and copy an exact snippet verbatim, including surrounding context.' };
          else if (count > 1) result = { success: false, error: `old_string appears ${count} times. Add more surrounding context so it matches exactly once.` };
          else { changes.push({ path, old_string, new_string, summary }); result = { success: true, staged: path }; }
        }

      } else if (block.name === 'escalate') {
        escalateResult = block.input.reason;
        done = true;
        result = { acknowledged: true };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    if (done) break;
    messages.push({ role: 'user', content: toolResults });
  }

  if (escalateResult) {
    return { escalate: true, reason: escalateResult, changes: [] };
  }

  return { escalate: false, changes };
}

// ---------------------------------------------------------------------------
// Anthropic API (direct fetch — no SDK needed in Workers)
// ---------------------------------------------------------------------------

async function callAnthropic(payload, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// AI safety reviewer (runs before an autoMerge change goes live)
// ---------------------------------------------------------------------------

// Ask Claude to judge whether a staged change is safe to publish to a live site with no human.
// Returns { safe, reason, summary }. Fails closed: if the reviewer errors or returns something
// unreadable, safe is false so the change waits for a person.
async function reviewChanges({ request, changes, env }) {
  const changeSummary = changes.map((c, i) =>
    `Change ${i + 1}, file: ${c.path}\n` +
    `What the agent says it did: ${c.summary}\n` +
    `--- CURRENT TEXT (before) ---\n${c.old_string}\n` +
    `--- NEW TEXT (after) ---\n${c.new_string}`
  ).join('\n\n');

  const system = `You are a careful release reviewer for WebEaze, a website care service for small businesses. Before a change is published to a client's live website with no human review, you decide whether it is safe.

Reply with STRICT JSON only. No prose, no markdown, no code fences. Use exactly this shape:
{"safe": true or false, "reason": "short explanation of your decision", "summary": "one plain, warm sentence a non-technical business owner would understand, describing what changed"}

Mark safe as false if the change: removes important content, breaks the HTML structure (unbalanced, malformed, or dropped tags), looks unrelated to what the client actually asked for, or is otherwise risky for a live site. When you are unsure, mark it unsafe so a person can look.`;

  const messages = [{
    role: 'user',
    content: `The client asked for this:\n**Request type:** ${request.type}\n**Description:** ${request.description}\n\nHere are the proposed change(s) to their live website:\n\n${changeSummary}\n\nReview these and reply with the strict JSON described above.`,
  }];

  let resp;
  try {
    resp = await callAnthropic({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages,
    }, env.CLAUDE_API_KEY);
  } catch (e) {
    return { safe: false, reason: `Safety review could not run: ${String((e && e.message) || e)}`, summary: '' };
  }

  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const parsed = parseReviewJson(text);
  if (!parsed) {
    return { safe: false, reason: 'Safety review returned an unreadable response.', summary: '' };
  }
  return {
    safe: parsed.safe === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}

// Pull the JSON object out of the model's reply, tolerating stray text or code fences around it.
function parseReviewJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'webeaze-request-bot',
    'Content-Type': 'application/json',
  };
}

async function listRepoFiles(repoFull, env) {
  const resp = await fetch(`https://api.github.com/repos/${repoFull}/contents/`, {
    headers: ghHeaders(env.GITHUB_TOKEN),
  });
  if (!resp.ok) return [];
  const items = await resp.json();
  return items
    .filter(i => i.type === 'file' && (i.name.endsWith('.html') || i.name.endsWith('.css')))
    .map(i => i.name);
}

async function getFileFromGitHub(repoFull, path, env) {
  const resp = await fetch(`https://api.github.com/repos/${repoFull}/contents/${encodeURIComponent(path)}`, {
    headers: ghHeaders(env.GITHUB_TOKEN),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  // GitHub returns base64-encoded content
  return atob(data.content.replace(/\n/g, ''));
}

async function getFileSha(repoFull, path, branch, env) {
  const resp = await fetch(
    `https://api.github.com/repos/${repoFull}/contents/${encodeURIComponent(path)}?ref=${branch}`,
    { headers: ghHeaders(env.GITHUB_TOKEN) }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.sha;
}

async function createBranchAndPR(repoFull, branchName, changes, prMeta, env) {
  const base = `https://api.github.com/repos/${repoFull}`;
  const headers = ghHeaders(env.GITHUB_TOKEN);

  // Get default branch + its tip SHA
  const repoResp = await fetch(base, { headers });
  if (!repoResp.ok) throw new Error(`Could not fetch repo info: ${repoResp.status}`);
  const repoData = await repoResp.json();
  const defaultBranch = repoData.default_branch;

  const refResp = await fetch(`${base}/git/ref/heads/${defaultBranch}`, { headers });
  if (!refResp.ok) throw new Error(`Could not fetch branch ref: ${refResp.status}`);
  const refData = await refResp.json();
  const baseSha = refData.object.sha;

  // Create new branch
  const branchResp = await fetch(`${base}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  if (!branchResp.ok) throw new Error(`Could not create branch: ${branchResp.status}`);

  // Apply each file's edits to its current content, then commit once per file.
  const byPath = {};
  for (const ch of changes) { (byPath[ch.path] = byPath[ch.path] || []).push(ch); }
  for (const path of Object.keys(byPath)) {
    const current = await getFileFromGitHub(repoFull, path, env);
    if (current === null) throw new Error(`Could not read ${path} to edit`);
    let updated = current;
    for (const e of byPath[path]) {
      if (!updated.includes(e.old_string)) throw new Error(`old_string no longer matches in ${path}`);
      updated = updated.replace(e.old_string, e.new_string);   // first occurrence
    }
    const fileSha = await getFileSha(repoFull, path, defaultBranch, env);
    const body = {
      message: byPath[path].map((c) => c.summary).join('; '),
      content: btoa(unescape(encodeURIComponent(updated))),
      branch: branchName,
    };
    if (fileSha) body.sha = fileSha;

    const putResp = await fetch(`${base}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (!putResp.ok) {
      throw new Error(`Could not commit ${path}: ${await putResp.text()}`);
    }
  }

  // Open PR
  const prResp = await fetch(`${base}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: prMeta.title,
      body: prMeta.body,
      head: branchName,
      base: defaultBranch,
    }),
  });
  if (!prResp.ok) {
    const err = await prResp.text();
    throw new Error(`Could not create PR: ${err}`);
  }
  const pr = await prResp.json();
  return { url: pr.html_url, number: pr.number };
}

// Squash-merge a PR (used only for autoMerge clients). Returns true on success; a merge that
// can't go through (conflict, required checks) returns false and the PR stays open for review.
async function mergePR(repoFull, number, env) {
  const resp = await fetch(`https://api.github.com/repos/${repoFull}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: ghHeaders(env.GITHUB_TOKEN),
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  if (!resp.ok) { console.error('Auto-merge failed:', await resp.text()); return false; }
  return true;
}

// Best-effort rollback of the most recent commit on the default branch. Used later by an
// auto-rollback watchdog, and reachable via POST {action:'revert', email}.
//
// Instead of force-pushing (which rewrites history and can break clones and deploy hooks), this
// creates a NEW forward commit whose tree matches the commit right before the last one. That
// restores the previous file contents while keeping full history, and the ref update is a plain
// fast-forward (force:false).
//
// Limitations:
//  - It undoes exactly ONE commit (the current tip). Call it again to step back further.
//  - It restores the whole repo to the state before that commit, so any other changes landed in the
//    same commit are undone too. The bot commits one request at a time, so in practice the tip is
//    the change we want to roll back.
//  - It cannot revert the initial commit (no parent to restore to).
//  - It reverts by commit, not by PR, so it assumes the last commit is the one to undo.
async function revertLastMerge(repoFull, env) {
  const base = `https://api.github.com/repos/${repoFull}`;
  const headers = ghHeaders(env.GITHUB_TOKEN);

  const repoResp = await fetch(base, { headers });
  if (!repoResp.ok) return { ok: false, error: `Could not fetch repo info: ${repoResp.status}` };
  const defaultBranch = (await repoResp.json()).default_branch;

  const refResp = await fetch(`${base}/git/ref/heads/${defaultBranch}`, { headers });
  if (!refResp.ok) return { ok: false, error: `Could not fetch branch ref: ${refResp.status}` };
  const headSha = (await refResp.json()).object.sha;

  const headCommitResp = await fetch(`${base}/git/commits/${headSha}`, { headers });
  if (!headCommitResp.ok) return { ok: false, error: `Could not read last commit: ${headCommitResp.status}` };
  const headCommit = await headCommitResp.json();
  if (!headCommit.parents || headCommit.parents.length === 0) {
    return { ok: false, error: 'Nothing to revert: the last commit has no parent.' };
  }
  const parentSha = headCommit.parents[0].sha;

  const parentCommitResp = await fetch(`${base}/git/commits/${parentSha}`, { headers });
  if (!parentCommitResp.ok) return { ok: false, error: `Could not read previous commit: ${parentCommitResp.status}` };
  const parentTreeSha = (await parentCommitResp.json()).tree.sha;

  // New commit that points at the previous tree, kept as a forward commit (parent = current tip).
  const commitResp = await fetch(`${base}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: `Revert last change (restore state before ${headSha.slice(0, 7)})`,
      tree: parentTreeSha,
      parents: [headSha],
    }),
  });
  if (!commitResp.ok) return { ok: false, error: `Could not create revert commit: ${await commitResp.text()}` };
  const newCommitSha = (await commitResp.json()).sha;

  // Fast-forward the branch. No force needed: the new commit's parent is the current tip.
  const patchResp = await fetch(`${base}/git/refs/heads/${defaultBranch}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: newCommitSha, force: false }),
  });
  if (!patchResp.ok) return { ok: false, error: `Could not update branch: ${await patchResp.text()}` };

  return { ok: true, reverted: headSha, commit: newCommitSha };
}

async function createGitHubIssue(repoFull, { title, body }, env) {
  const resp = await fetch(`https://api.github.com/repos/${repoFull}/issues`, {
    method: 'POST',
    headers: ghHeaders(env.GITHUB_TOKEN),
    body: JSON.stringify({
      title,
      body,
      labels: ['client-request', 'needs-review'],
    }),
  });
  if (!resp.ok) {
    console.error('Could not create issue:', await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.html_url || null;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatPRBody({ submittedBy, email, requestType, description, changes }) {
  const fileList = changes.map(c => `- \`${c.path}\` — ${c.summary}`).join('\n');
  return `**Requested by:** ${submittedBy} (${email})
**Type:** ${requestType}

**Original request:**
> ${description}

**Files changed:**
${fileList}

---
*Automatically processed by WebEaze request bot. Review the diff and merge when ready.*`;
}

function formatIssueBody({ submittedBy, email, requestType, description, reason }) {
  return `**Submitted by:** ${submittedBy} (${email})
**Type:** ${requestType}

**Description:**
> ${description}

**Why this needs manual handling:**
${reason}

---
*Could not be automatically processed. Assign to a developer.*`;
}
