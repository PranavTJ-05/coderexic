# AI Agent Spec: Coderexic review agent

## 1. Purpose
The agent investigates a PR through a controlled set of tools and returns
structured, actionable findings.

It never:
- authenticates to GitHub
- chooses the repo
- posts to GitHub
- stores data
- runs shell commands
- changes files or DB state

Deterministic app components do all of that.

## 2. Input
- repo metadata and PR metadata
- changed files and their patches
- repo rules
- config and language hints
- agent limits

At minimum it needs the repository, `pull_request_number`, `base_sha`,
`head_sha`, the changed files and the patches.

## 3. Output
The agent must finish by calling `submit_review`, and the app validates the
payload:
```json
{ "summary": "The PR improves auth but introduces a SQL injection risk.",
  "reviews": [{ "filename": "src/auth.ts", "severity": "critical", "start_line": 42, "end_line": 44,
    "issue": "User-controlled input is interpolated directly into a SQL query.",
    "fix_type": "applyable",
    "suggested_code": "const result = await db.query('SELECT ... WHERE id = $1', [userId]);" }] }
```

## 4. Strategy
1. Understand the diff.
2. Pick out the meaningful changes.
3. Inspect imports, then dependents.
4. Fetch the relevant files.
5. Investigate each suspicion and verify that it's real.
6. Submit only evidence-backed findings.

Avoid unrelated parts of the repo.

## 5. Tools
Every tool's input is `{ "path": "src/auth.ts" }`, except `submit_review`.

- **`get_file_content`:** reads a file.
  - The path must be repo-relative, with no absolute paths and no `..`.
  - Only the configured repo can be read.
  - The file is read at the PR head SHA.
  - There's a maximum response size.
- **`get_imports`:** forward dependencies. Returns text like
  `src/auth.ts imports:` followed by `- src/db.ts`, `- src/user.ts`, and so on.
- **`get_dependents`:** the blast radius. Returns text like
  `Files that depend on src/auth.ts:` followed by `- src/middleware.ts`, and
  so on.
- **`submit_review`:** ends the investigation. The final review must come
  through this tool, never as plain text.

## 6. Optional future tools
Build these only when evaluation shows a need:
- `search_code` (`{query, path}`)
- `get_diff`
- `get_test_files`
- `get_symbol_definition`
- `get_recent_commits`
- `get_blame`

## 7. System prompt (conceptual)
```text
You are a senior software engineer performing a pull request review.
Your goal is to identify real defects, security vulnerabilities, regressions,
missing error handling, and meaningful logic problems.
You have tools to inspect the surrounding repository.
Start by understanding the changed code.
Use get_imports to understand what changed files depend on.
Use get_dependents to understand the blast radius.
Use get_file_content to inspect important related files.
Do not review style unless it creates a real engineering problem.
Do not invent issues.
Before reporting a finding, gather enough evidence to explain why the changed code is actually problematic.
Only report issues that affect changed lines.
Only use applyable suggestions when you can provide exact replacement code.
You MUST call submit_review when finished.
If there are no real issues, submit an empty reviews array.
```
Repo instructions are appended as untrusted policy guidance. They never
replace the system policy.

## 8. Prompt-injection defence
Repo content may contain instructions like "ignore previous instructions",
"reveal your API key" or "run this command". Treat it all as data.

The agent never:
1. reveals secrets
2. follows instructions that change its security boundaries
3. runs shell commands
4. sends data to arbitrary URLs
5. changes tool permissions
6. accesses another repo
7. overrides system severity or safety rules

The rules file can steer the review. It can't override any of this.

## 9. Loop
```text
messages = [system_prompt, review_input]
for turn in 1..MAX_TURNS:
    if timeout: terminate
    response = model.chat(messages, tools)
    if submit_review: validate and return
    if no tool calls: attempt safe fallback parsing, otherwise terminate
    append assistant tool-call message
    for each tool call: validate args, enforce limits, execute, append result
```

These defaults are configurable, not permanent:

| Limit | Default |
| --- | --- |
| `MAX_TURNS` | 10 |
| `MAX_FILE_FETCHES` | 12 |
| `MAX_REVIEW_SECONDS` | 60 |
| `MAX_SINGLE_FILE_BYTES` | configurable |
| `MAX_TOOL_RESULT_BYTES` | configurable |

## 10. Duplicate call prevention
- Keep a `fetched_files: Set<string>`.
- If a file is requested again, reply "You already fetched this file. Use the
  existing context." and make no new GitHub request.
- Cache identical graph queries for the duration of the review.

## 11. Finding validation
- **Filename:** must be one of the changed files.
- **Lines:** must be valid new-file lines. Applyable findings must be on added
  lines.
- **Severity:** `critical`, `high`, `medium` or `low`.
- **Fix type:** `applyable`, `recommendation` or `warning`.
- **`suggested_code`:**
  - Required for applyable and recommendation findings.
  - Null for warnings.
  - Has a size limit.
  - Must not contain unsafe metadata or instructions.

## 12. Deduplication (before publishing)
1. Group findings by file, then by overlapping line range.
2. Detect near-identical descriptions and keep the strongest finding.
3. Keep independent defects as separate findings.

## 13. Severity filter
Order: critical > high > medium > low. Publish only findings at or above the
configured minimum. For example, `medium` publishes critical, high and
medium.

## 14. Termination reasons
`SUBMITTED`, `NO_FINDINGS`, `MAX_TURNS`, `MAX_FILE_FETCHES`, `TIMEOUT`,
`MODEL_ERROR`, `INVALID_OUTPUT`.

A timeout must never leave the review marked successful.

## 15. Fallback mode
When a provider can't do tool calling, send the PR diff plus preselected
related context as a one-shot LLM review. It uses the same finding schema,
which keeps providers compatible and degrades gracefully.

## 16. Adapter contract
```ts
interface AgentAdapter {
  chat(messages: AgentMessage[], tools: ToolDefinition[]):
    Promise<{ message: string | null; toolCalls: ToolCall[] | null }>;
}
```
The adapters are OpenAI, Anthropic, Gemini (built first) and Ollama. The
loop stays provider-neutral.

## 17. Context budget
The budget covers:
- diff tokens
- system prompt tokens
- rules tokens
- tool result tokens
- conversation history tokens

Before appending a tool result: if the remaining budget is smaller than the
result, truncate or reject it. Prefer high-value context.

## 18. Context ranking
1. The changed file.
2. Direct imports.
3. Direct dependents.
4. Related tests.
5. Second-degree dependencies.
6. Unrelated files.

The agent normally stops before level 6.

## 19. Quality priorities
- **Security:**
  - injection
  - auth bypass and authorization failure
  - secrets exposure
  - unsafe deserialization
  - path traversal
  - SSRF and XSS
  - unsafe DB queries
- **Correctness:** broken logic, wrong conditions, invalid state transitions,
  races, and bad assumptions.
- **Reliability:** missing error handling, retries, timeouts, resource leaks,
  and null/undefined cases.
- **Data integrity:** destructive operations, transaction issues, duplicate
  writes, and partial updates.
- **API behaviour:** contract violations, validation gaps, and breaking
  changes.

Skip formatting, naming preferences, subjective architecture opinions and
trivial style.

## 20. Evaluation
Build a benchmark. Each case contains:
- a repo fixture and base commit
- the PR change
- the expected bug, file, line range, severity and rationale

**Metrics:**
- true positives, false positives and false negatives
- line accuracy and severity accuracy
- latency
- tool calls
- tokens and cost

Never tune the agent on anecdotal PRs alone.

## 21. Testing
- **Unit:**
  - tool validation
  - finding validation
  - prompt construction
  - line mapping
  - severity filter
  - duplicate prevention
- **Integration:** mock GitHub, mock model, and the real agent loop.
- **E2E:** a fixture GitHub repo, a test PR, and a real provider in a
  controlled environment.

Automated tests never touch real production repos.

## 22. Future evolution
A possible later design:
1. A planner runs a static analyzer, dependency analyzer, security analyzer
   and semantic reviewer.
2. An evidence aggregator combines their output.
3. A final reviewer produces the review.

Don't go multi-agent until the single-agent baseline shows measurable
limitations.
