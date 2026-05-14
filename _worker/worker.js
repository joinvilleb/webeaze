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
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    // Respond to HubSpot immediately — processing happens in the background
    ctx.waitUntil(processRequest(payload, env));
    return new Response('OK', { status: 200 });
  }
};

// ---------------------------------------------------------------------------
// Main request processor
// ---------------------------------------------------------------------------

async function processRequest(payload, env) {
  const email = (payload.email || '').toLowerCase().trim();
  const description = payload.request_description || payload.message || payload.content || '';
  const requestType = payload.request_type || 'General update';
  const submittedBy = [payload.firstname, payload.lastname].filter(Boolean).join(' ') || 'Client';

  if (!email || !description) {
    console.log('Missing email or description — skipping');
    return;
  }

  // Look up client config
  let clients;
  try {
    clients = JSON.parse(env.CLIENTS_JSON || '{}');
  } catch {
    console.error('CLIENTS_JSON is not valid JSON');
    return;
  }

  const client = clients[email];
  if (!client) {
    console.log(`No client config for: ${email}`);
    return;
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
    await createGitHubIssue(repoFull, {
      title: `[Request] ${requestType} — ${submittedBy}`,
      body: formatIssueBody({ submittedBy, email, requestType, description, reason: result.reason }),
    }, env);
    console.log('Created GitHub Issue for manual review');
    return;
  }

  // Create branch, commit all changes, open PR
  try {
    const prUrl = await createBranchAndPR(repoFull, branchName, result.changes, {
      title: `[Request] ${requestType} — ${submittedBy}`,
      body: formatPRBody({ submittedBy, email, requestType, description, changes: result.changes }),
    }, env);
    console.log('PR created:', prUrl);
  } catch (err) {
    console.error('Failed to create PR:', err.message);
    // Fall back to a GitHub Issue so the request isn't lost
    await createGitHubIssue(repoFull, {
      title: `[Request] ${requestType} — ${submittedBy}`,
      body: formatIssueBody({ submittedBy, email, requestType, description, reason: `Auto-PR failed: ${err.message}` }),
    }, env);
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
      name: 'apply_change',
      description: 'Stage a file change. Call once per file you need to modify. Provide the COMPLETE new file content.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to modify' },
          new_content: { type: 'string', description: 'Complete new file content' },
          summary: { type: 'string', description: 'One sentence: what changed and why' },
        },
        required: ['path', 'new_content', 'summary'],
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
- For simple changes (text, phone number, hours, address, images, colors, adding/removing a list item or section), make the change and call apply_change.
- For anything requiring new functionality, integrations, significant layout restructures, or anything you are not fully confident about, call escalate.
- Read the relevant file first. Start with list_files if you are unsure which file to edit.
- Apply changes with apply_change. Provide the complete file content, not a diff.
- Make one apply_change call per file. If two files need editing, call apply_change twice.`;

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
      model: 'claude-sonnet-4-6',
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

      } else if (block.name === 'apply_change') {
        changes.push({
          path: block.input.path,
          new_content: block.input.new_content,
          summary: block.input.summary,
        });
        result = { success: true, staged: block.input.path };

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

  // Commit each changed file
  for (const change of changes) {
    const fileSha = await getFileSha(repoFull, change.path, defaultBranch, env);
    const body = {
      message: change.summary,
      content: btoa(unescape(encodeURIComponent(change.new_content))),
      branch: branchName,
    };
    if (fileSha) body.sha = fileSha;

    const putResp = await fetch(`${base}/contents/${encodeURIComponent(change.path)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (!putResp.ok) {
      const err = await putResp.text();
      throw new Error(`Could not commit ${change.path}: ${err}`);
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
  return pr.html_url;
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
  }
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
