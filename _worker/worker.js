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
    if (client.autoMerge) merged = await mergePR(repoFull, pr.number, env);
    return { ok: true, pr: pr.url, merged, files: result.changes.map((c) => c.path) };
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
