import type React from 'react'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import {
  buildGoalModeStartPrompt,
  cancelGoalMode,
  completeGoalMode,
  getActiveGoalMode,
  goalCompletionTag,
  isGoalContinuationCommand,
  isGoalStartCommand,
  startGoalMode,
} from '../utils/goalMode.js'
import { removeByFilter } from '../utils/messageQueueManager.js'

function removeQueuedGoalCommands(): void {
  removeByFilter(
    command => isGoalStartCommand(command) || isGoalContinuationCommand(command),
  )
}

function formatActiveGoal(): string {
  const goal = getActiveGoalMode()
  if (!goal) {
    return 'Goal mode is inactive. Start one with /goal <objective>.'
  }
  return [
    'Goal mode is active.',
    `Goal: ${goal.objective}`,
    `Completion tag: ${goalCompletionTag(goal)}`,
    `Continuations queued so far: ${goal.continuationCount}`,
  ].join('\n')
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const trimmed = args.trim()
  const subcommand = trimmed.toLowerCase()

  if (!trimmed || subcommand === 'status') {
    onDone(formatActiveGoal(), { display: 'system' })
    return null
  }

  if (['done', 'complete', 'completed'].includes(subcommand)) {
    const completed = completeGoalMode('user-command')
    removeQueuedGoalCommands()
    onDone(
      completed
        ? `Goal mode completed: ${completed.objective}`
        : 'Goal mode is already inactive.',
      { display: 'system' },
    )
    return null
  }

  if (['cancel', 'clear', 'stop', 'off'].includes(subcommand)) {
    const cancelled = cancelGoalMode()
    removeQueuedGoalCommands()
    onDone(
      cancelled
        ? `Goal mode cancelled: ${cancelled.objective}`
        : 'Goal mode is already inactive.',
      { display: 'system' },
    )
    return null
  }

  removeQueuedGoalCommands()
  const goal = startGoalMode(trimmed)
  onDone(`Goal mode enabled: ${goal.objective}`, {
    display: 'system',
    shouldQuery: true,
    metaMessages: [buildGoalModeStartPrompt(goal)],
  })
  return null
}
