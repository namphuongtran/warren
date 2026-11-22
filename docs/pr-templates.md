# Pull request templates

When configured forge behavior opens a pull request after a successful run, warren builds the body from named fragments. A project can replace individual fragments without copying the whole default template.

Create `.warren/pr-template.md` in the repository. Each `## <fragment_name>` heading replaces one default fragment:

```markdown
## trailer

Reviewed-by: @platform-team

Follow the project PR checklist before merge.
```

Unspecified fragments keep their defaults. A fragment with a whitespace-only body removes that section.

## Fragment names

- `title`
- `summary`
- `handoff`
- `agent_notes`
- `agent_report`
- `run`
- `seeds`
- `preview_url_or_placeholder`
- `commits`
- `files_changed`
- `prompt`
- `trailer`

Unknown fragment names and unbalanced preview markers surface through `warren doctor`.

## Default information

The generated body can include the agent's notes from the final commit body, the agent's report, the run link, commits, changed files, prompt, tracker context, preview URL, and a warren trailer. The exact content depends on the finalization result and configured integrations.

PR opening is not the core run guarantee. Warren always treats the pushed branch as its delivery boundary. Forge configuration and permissions determine whether it can open or find a pull request after that push.

The `handoff` fragment renders the run's validated `.warren/handoff.json` as a `## Handoff` section: the status, the summary, and the verification, how-to-try, and open-question lists. A summary that opens its own markdown heading is fenced, and list items are flattened to one line, so the report cannot break the body's sections. A run with a missing or invalid report gets a one-line note with the reason.

The `agent_report` fragment holds the run's final assistant message. That is the text of the last assistant `text` event before the terminal `result` event. Warren fences the message so it cannot break the surrounding markdown and caps it at 8 KiB, keeping the first and last 4 KiB, with a truncation note. A run with no assistant text renders no section. A run that recorded a handoff report renders no `agent_report` section, because the handoff replaces it.

For the complete fragment and preview-placeholder contract, read [Preview environments](previews.md) and the [preview design record](design/preview-environments.md).
