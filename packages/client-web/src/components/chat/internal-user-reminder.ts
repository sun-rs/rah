/** Provider-internal reminders can be encoded as user messages but must not
 * create public conversation boundaries. */
export function isInternalUserReminder(text: string): boolean {
  if (/<!--\s*OMO_INTERNAL_INITIATOR\s*-->/.test(text)) {
    return true;
  }
  if (!/^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/m.test(text)) {
    return false;
  }
  return /\[(?:ALL BACKGROUND TASKS COMPLETE|BACKGROUND TASK COMPLETED|BACKGROUND TASK FAILED)\]/.test(text);
}
