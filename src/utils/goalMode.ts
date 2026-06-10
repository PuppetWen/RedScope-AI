import { randomUUID } from 'crypto'
import type { Message } from '../types/message.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { getAssistantMessageText } from './messages.js'
import { createSignal } from './signal.js'

export type GoalModeState = {
  id: string
  objective: string
  startedAt: number
  continuationCount: number
}

export type CompletedGoalModeState = GoalModeState & {
  completedAt: number
  reason: string
}

let activeGoal: GoalModeState | null = null
let lastCompletedGoal: CompletedGoalModeState | null = null
const goalModeChanged = createSignal()

export type GoalModeSnapshot = {
  activeGoal: GoalModeState | null
  lastCompletedGoal: CompletedGoalModeState | null
}

let goalModeSnapshot: GoalModeSnapshot = Object.freeze({
  activeGoal: null,
  lastCompletedGoal: null,
})

function cloneGoal(goal: GoalModeState): GoalModeState {
  return { ...goal }
}

function refreshGoalModeSnapshot(): void {
  goalModeSnapshot = Object.freeze({
    activeGoal: activeGoal ? cloneGoal(activeGoal) : null,
    lastCompletedGoal: lastCompletedGoal ? { ...lastCompletedGoal } : null,
  })
  goalModeChanged.emit()
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function goalCompletionTag(goal: Pick<GoalModeState, 'id'>): string {
  return `<goal_complete id="${goal.id}" />`
}

export const subscribeToGoalMode = goalModeChanged.subscribe

export function getGoalModeSnapshot(): GoalModeSnapshot {
  return goalModeSnapshot
}

export function startGoalMode(
  objective: string,
  options: { id?: string; nowMs?: number } = {},
): GoalModeState {
  const trimmed = objective.trim()
  if (!trimmed) {
    throw new Error('Goal mode requires a non-empty objective.')
  }

  activeGoal = {
    id: options.id ?? randomUUID(),
    objective: trimmed,
    startedAt: options.nowMs ?? Date.now(),
    continuationCount: 0,
  }
  lastCompletedGoal = null
  refreshGoalModeSnapshot()
  return cloneGoal(activeGoal)
}

export function getActiveGoalMode(): GoalModeState | null {
  return activeGoal ? cloneGoal(activeGoal) : null
}

export function getLastCompletedGoalMode(): CompletedGoalModeState | null {
  return lastCompletedGoal ? { ...lastCompletedGoal } : null
}

export function completeGoalMode(
  reason = 'completed',
  nowMs = Date.now(),
): CompletedGoalModeState | null {
  if (!activeGoal) return null
  lastCompletedGoal = {
    ...activeGoal,
    completedAt: nowMs,
    reason,
  }
  activeGoal = null
  refreshGoalModeSnapshot()
  return { ...lastCompletedGoal }
}

export function cancelGoalMode(): GoalModeState | null {
  if (!activeGoal) return null
  const cancelled = cloneGoal(activeGoal)
  activeGoal = null
  refreshGoalModeSnapshot()
  return cancelled
}

export function buildGoalModeStartPrompt(goal: GoalModeState): string {
  const objective = escapeXml(goal.objective)
  const completionTag = goalCompletionTag(goal)
  return [
    `<goal_mode id="${goal.id}">`,
    `<objective>${objective}</objective>`,
    'You are in goal mode. Keep working until the objective is genuinely complete.',
    'Do not stop after only planning or after a partial step. Continue choosing and executing the next useful action.',
    'If you are blocked, explain the blocker and keep the goal active instead of marking it complete.',
    `When and only when the objective is complete, include this exact tag in your assistant response: ${completionTag}`,
    '</goal_mode>',
  ].join('\n')
}

export function buildGoalModeContinuationPrompt(goal: GoalModeState): string {
  const objective = escapeXml(goal.objective)
  const completionTag = goalCompletionTag(goal)
  return [
    `<goal_mode_continuation id="${goal.id}" count="${goal.continuationCount}">`,
    `<objective>${objective}</objective>`,
    'The goal is still active. Continue from the current repository/session state and make the next concrete progress toward the objective.',
    'If the objective is now complete, include the exact completion tag below. Otherwise keep working and do not ask whether to continue.',
    completionTag,
    '</goal_mode_continuation>',
  ].join('\n')
}

export function assistantTextCompletesGoal(
  text: string,
  goal: Pick<GoalModeState, 'id'>,
): boolean {
  const id = escapeRegExp(goal.id)
  const completionTagPattern = new RegExp(
    `<goal_complete\\s+id=["']${id}["']\\s*/?>`,
    'i',
  )
  return completionTagPattern.test(text)
}

export function maybeCompleteGoalFromMessages(
  messages: readonly Message[],
): CompletedGoalModeState | null {
  const goal = activeGoal
  if (!goal) return null

  for (let i = messages.length - 1; i >= 0; i--) {
    const text = getAssistantMessageText(messages[i]!)
    if (text && assistantTextCompletesGoal(text, goal)) {
      return completeGoalMode('assistant-completion-tag')
    }
  }
  return null
}

export function isGoalContinuationCommand(command: QueuedCommand): boolean {
  return (
    command.isMeta === true &&
    typeof command.value === 'string' &&
    command.value.includes('<goal_mode_continuation')
  )
}

export function isGoalStartCommand(command: QueuedCommand): boolean {
  return (
    command.isMeta === true &&
    typeof command.value === 'string' &&
    command.value.includes('<goal_mode ')
  )
}

export function createGoalStartCommand(goal: GoalModeState): QueuedCommand {
  return {
    value: buildGoalModeStartPrompt(goal),
    mode: 'prompt',
    priority: 'later',
    isMeta: true,
    skipSlashCommands: true,
  }
}

export function createGoalContinuationCommandIfNeeded({
  messages,
  queuedCommands,
  wasAborted,
}: {
  messages: readonly Message[]
  queuedCommands: readonly QueuedCommand[]
  wasAborted: boolean
}): QueuedCommand | null {
  if (wasAborted) return null
  if (maybeCompleteGoalFromMessages(messages)) return null

  if (!activeGoal) return null
  if (
    queuedCommands.some(
      command =>
        isGoalStartCommand(command) || isGoalContinuationCommand(command),
    )
  ) {
    return null
  }

  activeGoal = {
    ...activeGoal,
    continuationCount: activeGoal.continuationCount + 1,
  }
  refreshGoalModeSnapshot()

  return {
    value: buildGoalModeContinuationPrompt(activeGoal),
    mode: 'prompt',
    priority: 'later',
    isMeta: true,
    skipSlashCommands: true,
  }
}

export function resetGoalModeForTests(): void {
  activeGoal = null
  lastCompletedGoal = null
  refreshGoalModeSnapshot()
}
