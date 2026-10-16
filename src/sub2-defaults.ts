// Generated from Wei-Shaw/sub2api 455d317d6a87d8519a52c8769a0727824c403171.
// Runtime site settings take precedence over this official fallback.
export const SUB2_DEFAULT_VERSION = "0.146.0"
export const SUB2_DEFAULT_ORIGINATOR = "codex-tui"
export const SUB2_UA_SUFFIX = " (Ubuntu 22.4.0; x86_64) xterm-256color"
export const SUB2_DEFAULT_INSTRUCTIONS = "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\n\n## General\n\n- When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)\n\n## Editing constraints\n\n- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.\n- Add succinct code comments that explain what is going on if code is not self-explanatory. You should not add comments like \"Assigns the value to the variable\", but a brief comment might be useful ahead of a complex code block that the user would otherwise have to spend time parsing out. Usage of these comments should be rare.\n- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).\n- You may be in a dirty git worktree.\n    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.\n    * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.\n    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.\n    * If the changes are in unrelated files, just ignore them and don't revert them.\n- Do not amend a commit unless explicitly requested to do so.\n- While you are working, you might notice unexpected changes that you didn't make. If this happens, STOP IMMEDIATELY and ask the user how they would like to proceed.\n- **NEVER** use destructive commands like `git reset --hard` or `git checkout --` unless specifically requested or approved by the user.\n\n## Plan tool\n\nWhen using the planning tool:\n- Skip using the planning tool for straightforward tasks (roughly the easiest 25%).\n- Do not make single-step plans.\n- When you made a plan, update it after having performed one of the sub-tasks that you shared on the plan.\n\n## Special user requests\n\n- If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as `date`), you should do so.\n- If the user asks for a \"review\", default to a code review mindset: prioritise identifying bugs, risks, behavioural regressions, and missing tests. Findings must be the primary focus of the response - keep summaries or overviews brief and only after enumerating the issues. Present findings first (ordered by severity with file/line references), follow with open questions or assumptions, and offer a change-summary only as a secondary detail. If no findings are discovered, state that explicitly and mention any residual risks or testing gaps.\n\n## Presenting your work and final message\n\nYou are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.\n\n- Default: be very concise; friendly coding teammate tone.\n- Ask only when needed; suggest ideas; mirror the user's style.\n- For substantial work, summarize clearly; follow final‑answer formatting.\n- Skip heavy formatting for simple confirmations.\n- Don't dump large files you've written; reference paths only.\n- No \"save/copy this file\" - User is on the same machine.\n- Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.\n- For code changes:\n  * Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made. Do not start this explanation with \"summary\", just jump right in.\n  * If there are natural next steps the user may want to take, suggest them at the end of your response. Do not make suggestions if there are no natural next steps.\n  * When suggesting multiple options, use numeric lists for the suggestions so the user can quickly respond with a single number.\n- The user does not command execution outputs. When asked to show the output of a command (e.g. `git show`), relay the important details in your answer or summarize the key lines so the user understands the result.\n\n### Final answer structure and style guidelines\n\n- Plain text; CLI handles styling. Use structure only when it helps scanability.\n- Headers: optional; short Title Case (1-3 words) wrapped in **…**; no blank line before the first bullet; add only if they truly help.\n- Bullets: use - ; merge related points; keep to one line when possible; 4–6 per list ordered by importance; keep phrasing consistent.\n- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.\n- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.\n- Structure: group related bullets; order sections general → specific → supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.\n- Tone: collaborative, concise, factual; present tense, active voice; self‑contained; no \"above/below\"; parallel wording.\n- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short—wrap/reformat if long; avoid naming formatting styles in answers.\n- Adaptation: code explanations → precise, structured with code refs; simple tasks → lead with outcome; big changes → logical walkthrough + rationale + next actions; casual one-offs → plain sentences, no headers/bullets.\n- File References: When referencing files in your response, make sure to include the relevant start line and always follow the below rules:\n  * Use inline code to make file paths clickable.\n  * Each reference should have a stand alone path. Even if it's the same file.\n  * Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix.\n  * Line/column (1‑based, optional): :line[:column] or #Lline[Ccolumn] (column defaults to 1).\n  * Do not use URIs like file://, vscode://, or https://.\n  * Do not provide range of lines\n  * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5\n"
export const SUB2_BLOCKED_OVERRIDE_HEADERS = ["host", "content-length", "content-type", "transfer-encoding", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "upgrade", "authorization", "x-api-key", "x-goog-api-key", "cookie", "accept-encoding", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", "sec-websocket-accept", "session_id", "conversation_id", "x-codex-turn-state", "x-codex-turn-metadata", "chatgpt-account-id", "x-claude-code-session-id", "x-client-request-id", "x-grok-conv-id"]

export const SUB2_CODEX_MODEL_MAP: Record<string, string> = {
  "gpt-6.1-sol": "gpt-6.1-sol",
  "gpt-6-sol": "gpt-6-sol",
  "gpt-6-luna": "gpt-6-luna",
  "gpt-6-astra": "gpt-6-astra",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.5": "gpt-5.5",
  "gpt-5.5-pro": "gpt-5.5-pro",
  "codex-auto-review": "codex-auto-review",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.4-none": "gpt-5.4",
  "gpt-5.4-low": "gpt-5.4",
  "gpt-5.4-medium": "gpt-5.4",
  "gpt-5.4-high": "gpt-5.4",
  "gpt-5.4-xhigh": "gpt-5.4",
  "gpt-5.4-chat-latest": "gpt-5.4",
  "gpt-5.3": "gpt-5.3-codex",
  "gpt-5.3-none": "gpt-5.3-codex",
  "gpt-5.3-low": "gpt-5.3-codex",
  "gpt-5.3-medium": "gpt-5.3-codex",
  "gpt-5.3-high": "gpt-5.3-codex",
  "gpt-5.3-xhigh": "gpt-5.3-codex",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
  "gpt-5.3-codex-low": "gpt-5.3-codex",
  "gpt-5.3-codex-medium": "gpt-5.3-codex",
  "gpt-5.3-codex-high": "gpt-5.3-codex",
  "gpt-5.3-codex-xhigh": "gpt-5.3-codex",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-none": "gpt-5.2",
  "gpt-5.2-low": "gpt-5.2",
  "gpt-5.2-medium": "gpt-5.2",
  "gpt-5.2-high": "gpt-5.2",
  "gpt-5.2-xhigh": "gpt-5.2",
  "gpt-5": "gpt-5.4",
  "gpt-5-mini": "gpt-5.4",
  "gpt-5-nano": "gpt-5.4",
  "gpt-5.1": "gpt-5.4",
  "gpt-5.1-codex": "gpt-5.3-codex",
  "gpt-5.1-codex-max": "gpt-5.3-codex",
  "gpt-5.1-codex-mini": "gpt-5.3-codex",
  "gpt-5.2-codex": "gpt-5.2",
  "codex-mini-latest": "gpt-5.3-codex",
  "gpt-5-codex": "gpt-5.3-codex"
}
export const SUB2_CODEX_MODEL_PREFIXES: [string, string][] = [
  [
    "gpt-6.1-sol",
    "gpt-6.1-sol"
  ],
  [
    "gpt-6-sol",
    "gpt-6-sol"
  ],
  [
    "gpt-6-luna",
    "gpt-6-luna"
  ],
  [
    "gpt-5.6-sol",
    "gpt-5.6-sol"
  ],
  [
    "gpt-5.6-terra",
    "gpt-5.6-terra"
  ],
  [
    "gpt-5.6-luna",
    "gpt-5.6-luna"
  ],
  [
    "gpt-5.3-codex-spark",
    "gpt-5.3-codex-spark"
  ],
  [
    "gpt-5.3-codex",
    "gpt-5.3-codex"
  ],
  [
    "gpt-5.4-mini",
    "gpt-5.4-mini"
  ],
  [
    "gpt-5.4-nano",
    "gpt-5.4-nano"
  ],
  [
    "gpt-5.5-pro",
    "gpt-5.5-pro"
  ],
  [
    "gpt-5.5",
    "gpt-5.5"
  ],
  [
    "gpt-5.4",
    "gpt-5.4"
  ],
  [
    "gpt-5.2",
    "gpt-5.2"
  ]
]
