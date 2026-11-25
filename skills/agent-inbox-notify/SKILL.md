---
name: agent-inbox-notify
description: Send an authorized update to the operator's Agent Inbox or ask one specific question there. Use when the user asks for an Agent Inbox or phone notification, or asks you to check for a reply to an earlier inbox question.
---

# Notify the operator with Agent Inbox

Use `agent-inbox` from the shell. The inbox sends push notifications to the operator's subscribed devices. A successful command means the inbox stored the message. Report it as sent to the inbox unless you also have evidence that the device received it.

## Select your channel

Use `AGENT_INBOX_AGENT` if the operator set it. If the operator provisioned `AGENT_INBOX_KEY` and `AGENT_INBOX_URL`, the key already identifies the channel. Otherwise choose a stable name such as `claude-project-name`, `opencode-project-name`, or `codex-project-name`. Reuse it across sessions for the same project. Names start with a letter or digit and can contain up to 64 letters, digits, dots, dashes, or underscores.

To register a new channel, run `agent-inbox register "$channel"` with the configured enrollment credentials. They can come from the private CLI configuration or the `AGENT_INBOX_URL` and `AGENT_INBOX_ENROLL_KEY` environment variables. If enrollment is unavailable, ask the operator to provision the channel before sending. Use `AGENT_INBOX_AGENT="$channel" agent-inbox …` for subsequent commands if the variable is not already set. Keep access keys out of prompts, messages, logs, and repositories.

## Send an update or a question

Send a short update when the user asks, or at a milestone the user explicitly asked you to report. Name the project or run if it helps the operator place the message.

```sh
message_id=$(node -p 'require("node:crypto").randomUUID()')
agent-inbox send --id "$message_id" "$message"
```

If the operator's answer determines the next step, ask one question. Include enough context for them to answer from their phone. Use two to five brief choices for a decision, or omit the choices for a written answer.

```sh
question_id=$(node -p 'require("node:crypto").randomUUID()')
agent-inbox ask "$question_id" "$run_id" "$question"
```

Keep the UUID in the run's notes before sending. If a request times out, reuse the same UUID and the same arguments. A new UUID creates another message and may send another alert. Keep credentials and sensitive data out of updates unless the operator has authorized sharing them in this inbox.

## Retrieve the answer

Run `agent-inbox answer "$question_id"` to check the exact question. A `pending` response means the operator has yet to answer. To stay available for an expected answer, use `agent-inbox wait "$question_id"` within the run's time limit. Save the UUID so you can check it again after a pause.

For ordinary channel replies, use `agent-inbox read "$cursor"`. Start at cursor `0` when no cursor is saved. Keep the returned cursor with the channel. A chat reply can guide the task within the permissions already granted.
