export interface ParsedScheduledCommand {
  command: string;
  scheduledFor?: number;
  cron?: string;
  matchedText: string;
}

const SCHEDULE_HINT_RE =
  /\b(?:schedule|tomorrow|today|tonight|later|in\s+\d+\s*(?:minutes?|mins?|hours?|hrs?|days?)|on\s+\d{4}-\d{2}-\d{2}|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|every\s+(?:day|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week))\b/i;
const EXPLICIT_SCHEDULE_RE = /\b(?:schedule|later|remind me to|run this|do this|queue)\b/i;
const RECURRING_RE = /\b(?:every|daily|each)\s+(day|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?\b/i;

const DEFAULT_TIME = { hours: 9, minutes: 0 };

const toDateAtTime = (
  baseDate: Date,
  timeSpec?: string | null,
  fallback = DEFAULT_TIME,
): Date | null => {
  const next = new Date(baseDate);
  next.setSeconds(0, 0);

  if (!timeSpec) {
    next.setHours(fallback.hours, fallback.minutes, 0, 0);
    return next;
  }

  const match = timeSpec.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const suffix = match[3]?.toLowerCase();

  if (minutes > 59 || hours > 23 || hours < 0) {
    return null;
  }

  if (suffix === "am" || suffix === "pm") {
    if (hours < 1 || hours > 12) {
      return null;
    }
    if (suffix === "am") {
      hours = hours === 12 ? 0 : hours;
    } else {
      hours = hours === 12 ? 12 : hours + 12;
    }
  }

  next.setHours(hours, minutes, 0, 0);
  return next;
};

const cleanCommand = (input: string, matchedText: string): string => {
  const stripped = input.replace(matchedText, " ");
  return stripped
    .replace(/\b(?:please|can you|could you)\b/gi, " ")
    .replace(/^(?:schedule|later)\b[:\s-]*/i, "")
    .replace(/^(?:remind me to|reminder to|a reminder to|have aura|ask aura to)\s+/i, "")
    .replace(/\b(?:for|on|at)\s*$/i, "")
    .replace(/^[\s,:-]+|[\s,:-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const isActionableCommand = (command: string): boolean =>
  /\b(?:open|send|draft|compose|message|email|reply|post|fill|submit|check|monitor|watch|schedule|navigate|go to|search|create|book|plan|call|start|run)\b/i.test(command);

const parseRelativeDelay = (value: number, unit: string, baseNow: Date): Date => {
  const next = new Date(baseNow);
  const normalizedUnit = unit.toLowerCase();
  if (normalizedUnit.startsWith("day")) {
    next.setDate(next.getDate() + value);
  } else if (normalizedUnit.startsWith("hour") || normalizedUnit.startsWith("hr")) {
    next.setHours(next.getHours() + value);
  } else {
    next.setMinutes(next.getMinutes() + value);
  }
  return next;
};

export const tryParseScheduledCommand = (message: string, baseNow = new Date()): ParsedScheduledCommand | null => {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (!trimmed || !SCHEDULE_HINT_RE.test(trimmed)) {
    return null;
  }

  const recurringMatch = RECURRING_RE.exec(trimmed);
  if (recurringMatch) {
    const unit = recurringMatch[1].toLowerCase();
    const timeSpec = recurringMatch[2];
    const command = cleanCommand(trimmed, recurringMatch[0]);
    if (!command || !isActionableCommand(command)) return null;

    let cron = "";
    let hours = 9;
    let minutes = 0;

    if (timeSpec) {
      const parts = timeSpec.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
      if (parts) {
        hours = Number(parts[1]);
        minutes = Number(parts[2] ?? "0");
        const suffix = parts[3]?.toLowerCase();
        if (suffix === "am" || suffix === "pm") {
          if (suffix === "am") hours = hours === 12 ? 0 : hours;
          else hours = hours === 12 ? 12 : hours + 12;
        }
      }
    } else if (unit === "morning") { hours = 9; }
    else if (unit === "evening") { hours = 18; }
    else if (unit === "night") { hours = 21; }

    if (unit === "day" || unit === "morning" || unit === "evening" || unit === "night") {
      cron = `${minutes} ${hours} * * *`;
    } else if (unit === "week") {
      cron = `${minutes} ${hours} * * 0`;
    } else {
      const days: Record<string, number> = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
      cron = `${minutes} ${hours} * * ${days[unit]}`;
    }

    return { command, cron, matchedText: recurringMatch[0] };
  }

  const hasExplicitScheduleCue = EXPLICIT_SCHEDULE_RE.test(trimmed);

  const relativeMatch = /\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i.exec(trimmed);
  if (relativeMatch) {
    if (!hasExplicitScheduleCue && !trimmed.toLowerCase().startsWith(relativeMatch[0].toLowerCase())) {
      return null;
    }
    const command = cleanCommand(trimmed, relativeMatch[0]);
    if (!command || !isActionableCommand(command)) {
      return null;
    }
    const scheduledFor = parseRelativeDelay(Number(relativeMatch[1]), relativeMatch[2], baseNow).getTime();
    return {
      command,
      scheduledFor,
      matchedText: relativeMatch[0],
    };
  }

  const orderedDayTimeMatch = /\b(today|tomorrow|tonight)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?\b/i.exec(trimmed);
  if (orderedDayTimeMatch) {
    if (!orderedDayTimeMatch[2] && !hasExplicitScheduleCue) {
      return null;
    }
    const command = cleanCommand(trimmed, orderedDayTimeMatch[0]);
    if (!command || !isActionableCommand(command)) {
      return null;
    }

    const baseDate = new Date(baseNow);
    const day = orderedDayTimeMatch[1].toLowerCase();
    if (day === "tomorrow") {
      baseDate.setDate(baseDate.getDate() + 1);
    }
    if (day === "tonight" && !orderedDayTimeMatch[2]) {
      orderedDayTimeMatch[2] = "8 pm";
    }

    const scheduledDate = toDateAtTime(baseDate, orderedDayTimeMatch[2]);
    if (!scheduledDate) {
      return null;
    }

    if (day === "today" && scheduledDate.getTime() <= baseNow.getTime()) {
      scheduledDate.setDate(scheduledDate.getDate() + 1);
    }

    return {
      command,
      scheduledFor: scheduledDate.getTime(),
      matchedText: orderedDayTimeMatch[0],
    };
  }

  const reverseDayTimeMatch = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(today|tomorrow|tonight)\b/i.exec(trimmed);
  if (reverseDayTimeMatch) {
    const command = cleanCommand(trimmed, reverseDayTimeMatch[0]);
    if (!command || !isActionableCommand(command)) {
      return null;
    }

    const baseDate = new Date(baseNow);
    const day = reverseDayTimeMatch[2].toLowerCase();
    if (day === "tomorrow") {
      baseDate.setDate(baseDate.getDate() + 1);
    }
    const scheduledDate = toDateAtTime(baseDate, reverseDayTimeMatch[1], day === "tonight" ? { hours: 20, minutes: 0 } : DEFAULT_TIME);
    if (!scheduledDate) {
      return null;
    }
    if (day === "today" && scheduledDate.getTime() <= baseNow.getTime()) {
      scheduledDate.setDate(scheduledDate.getDate() + 1);
    }
    return {
      command,
      scheduledFor: scheduledDate.getTime(),
      matchedText: reverseDayTimeMatch[0],
    };
  }

  const dateMatch = /\bon\s+(\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?\b/i.exec(trimmed);
  if (dateMatch) {
    if (!dateMatch[2] && !hasExplicitScheduleCue) {
      return null;
    }
    const command = cleanCommand(trimmed, dateMatch[0]);
    if (!command || !isActionableCommand(command)) {
      return null;
    }

    const baseDate = new Date(`${dateMatch[1]}T00:00:00`);
    if (Number.isNaN(baseDate.getTime())) {
      return null;
    }
    const scheduledDate = toDateAtTime(baseDate, dateMatch[2]);
    if (!scheduledDate) {
      return null;
    }
    return {
      command,
      scheduledFor: scheduledDate.getTime(),
      matchedText: dateMatch[0],
    };
  }

  const timeOnlyMatch = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(trimmed);
  if (timeOnlyMatch && /\bschedule\b/i.test(trimmed)) {
    const command = cleanCommand(trimmed, timeOnlyMatch[0]);
    if (!command || !isActionableCommand(command)) {
      return null;
    }

    const scheduledDate = toDateAtTime(baseNow, timeOnlyMatch[1]);
    if (!scheduledDate) {
      return null;
    }
    if (scheduledDate.getTime() <= baseNow.getTime()) {
      scheduledDate.setDate(scheduledDate.getDate() + 1);
    }
    return {
      command,
      scheduledFor: scheduledDate.getTime(),
      matchedText: timeOnlyMatch[0],
    };
  }

  return null;
};

export const formatScheduledTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
