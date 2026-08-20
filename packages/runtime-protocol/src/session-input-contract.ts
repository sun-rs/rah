export interface SessionInputContractIssue {
  code: string;
  message: string;
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(code: string, message: string, path: string): SessionInputContractIssue {
  return { code, message, path };
}

export function validateSessionInputAttachmentsContract(
  value: unknown,
  path: string,
): SessionInputContractIssue[] {
  if (!Array.isArray(value)) {
    return [issue("session.attachments.invalid", "attachments must be an array", path)];
  }
  const issues: SessionInputContractIssue[] = [];
  value.forEach((attachment, index) => {
    const attachmentPath = `${path}[${index}]`;
    if (!isRecord(attachment)) {
      issues.push(issue("session.attachment.invalid", "attachment must be an object", attachmentPath));
      return;
    }
    if (!isNonEmptyString(attachment.id)) {
      issues.push(issue("session.attachment.id.invalid", "attachment id must be non-empty", `${attachmentPath}.id`));
    }
    if (attachment.kind !== "image" && attachment.kind !== "file") {
      issues.push(issue("session.attachment.kind.invalid", "attachment kind must be image or file", `${attachmentPath}.kind`));
    }
    if (!isNonEmptyString(attachment.name)) {
      issues.push(issue("session.attachment.name.invalid", "attachment name must be non-empty", `${attachmentPath}.name`));
    }
    if (!isNonEmptyString(attachment.mediaType)) {
      issues.push(issue("session.attachment.media_type.invalid", "attachment mediaType must be non-empty", `${attachmentPath}.mediaType`));
    }
    if (!Number.isInteger(attachment.size) || (attachment.size as number) < 0) {
      issues.push(issue("session.attachment.size.invalid", "attachment size must be a non-negative integer", `${attachmentPath}.size`));
    }
  });
  return issues;
}

export function validateSessionInputQueueContract(
  value: unknown,
  path: string,
): SessionInputContractIssue[] {
  if (!Array.isArray(value)) {
    return [issue("session.input_queue.invalid", "session inputQueue must be an array", path)];
  }
  const issues: SessionInputContractIssue[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue("session.input_queue.entry.invalid", "queued input must be an object", entryPath));
      return;
    }
    if (!isNonEmptyString(entry.clientMessageId)) {
      issues.push(issue("session.input_queue.message_id.invalid", "queued input clientMessageId must be non-empty", `${entryPath}.clientMessageId`));
    }
    if (entry.clientTurnId !== undefined && !isNonEmptyString(entry.clientTurnId)) {
      issues.push(issue("session.input_queue.turn_id.invalid", "queued input clientTurnId must be non-empty", `${entryPath}.clientTurnId`));
    }
    if (typeof entry.text !== "string") {
      issues.push(issue("session.input_queue.text.invalid", "queued input text must be a string", `${entryPath}.text`));
    }
    if (entry.attachments !== undefined) {
      issues.push(...validateSessionInputAttachmentsContract(entry.attachments, `${entryPath}.attachments`));
    }
    if (!isNonEmptyString(entry.queuedAt) || Number.isNaN(Date.parse(entry.queuedAt))) {
      issues.push(issue("session.input_queue.timestamp.invalid", "queued input queuedAt must be a valid timestamp", `${entryPath}.queuedAt`));
    }
    if (!Number.isInteger(entry.position) || (entry.position as number) < 1) {
      issues.push(issue("session.input_queue.position.invalid", "queued input position must be a positive integer", `${entryPath}.position`));
    }
    if (entry.state !== undefined && entry.state !== "queued" && entry.state !== "submitting") {
      issues.push(issue("session.input_queue.state.invalid", "queued input state must be queued or submitting", `${entryPath}.state`));
    }
  });
  return issues;
}

export function validateSessionInputAcceptedContract(
  value: unknown,
  path: string,
): SessionInputContractIssue[] {
  if (!isRecord(value)) {
    return [issue("session.input.accepted.invalid", "accepted input payload must be an object", path)];
  }
  const issues: SessionInputContractIssue[] = [];
  if (!isNonEmptyString(value.clientMessageId)) {
    issues.push(issue("session.input.accepted.message_id.invalid", "accepted input clientMessageId must be non-empty", `${path}.clientMessageId`));
  }
  if (value.clientTurnId !== undefined && !isNonEmptyString(value.clientTurnId)) {
    issues.push(issue("session.input.accepted.turn_id.invalid", "accepted input clientTurnId must be non-empty when present", `${path}.clientTurnId`));
  }
  return issues;
}

export function validateSessionInputQueuePolicyContract(
  value: unknown,
  path: string,
): SessionInputContractIssue[] {
  return value === "queue" || value === "steer"
    ? []
    : [issue("session.input_queue_policy.invalid", "session input queue policy must be queue or steer", path)];
}
