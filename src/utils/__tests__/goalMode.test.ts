import { beforeEach, describe, expect, test } from 'bun:test'
import {
  buildGoalModeStartPrompt,
  createGoalContinuationCommandIfNeeded,
  createGoalStartCommand,
  getActiveGoalMode,
  goalCompletionTag,
  isGoalContinuationCommand,
  isGoalStartCommand,
  maybeCompleteGoalFromMessages,
  resetGoalModeForTests,
  startGoalMode,
} from '../goalMode'
import { createAssistantMessage } from '../messages'

beforeEach(() => {
  resetGoalModeForTests()
})

describe('goalMode', () => {
  test('starts a goal and builds a prompt with a unique completion tag', () => {
    const goal = startGoalMode('ship the audit report', {
      id: 'goal-1',
      nowMs: 100,
    })
    const prompt = buildGoalModeStartPrompt(goal)

    expect(goal).toMatchObject({
      id: 'goal-1',
      objective: 'ship the audit report',
      startedAt: 100,
      continuationCount: 0,
    })
    expect(prompt).toContain('ship the audit report')
    expect(prompt).toContain(goalCompletionTag(goal))
  })

  test('creates one hidden later-priority continuation command while active', () => {
    startGoalMode('finish the task', { id: 'goal-2' })

    const command = createGoalContinuationCommandIfNeeded({
      messages: [],
      queuedCommands: [],
      wasAborted: false,
    })

    expect(command).not.toBeNull()
    expect(command!.mode).toBe('prompt')
    expect(command!.priority).toBe('later')
    expect(command!.isMeta).toBe(true)
    expect(isGoalContinuationCommand(command!)).toBe(true)
    expect(getActiveGoalMode()?.continuationCount).toBe(1)
  })

  test('creates a hidden later-priority start command', () => {
    const goal = startGoalMode('finish the task', { id: 'goal-start' })

    const command = createGoalStartCommand(goal)

    expect(command.mode).toBe('prompt')
    expect(command.priority).toBe('later')
    expect(command.isMeta).toBe(true)
    expect(command.skipSlashCommands).toBe(true)
    expect(isGoalStartCommand(command)).toBe(true)
  })

  test('does not duplicate an already queued goal continuation', () => {
    startGoalMode('finish the task', { id: 'goal-3' })
    const existing = createGoalContinuationCommandIfNeeded({
      messages: [],
      queuedCommands: [],
      wasAborted: false,
    })

    const duplicate = createGoalContinuationCommandIfNeeded({
      messages: [],
      queuedCommands: [existing!],
      wasAborted: false,
    })

    expect(duplicate).toBeNull()
    expect(getActiveGoalMode()?.continuationCount).toBe(1)
  })

  test('does not queue a continuation while a goal start command is waiting', () => {
    const goal = startGoalMode('finish the task', { id: 'goal-queued' })
    const startCommand = createGoalStartCommand(goal)

    const continuation = createGoalContinuationCommandIfNeeded({
      messages: [],
      queuedCommands: [startCommand],
      wasAborted: false,
    })

    expect(continuation).toBeNull()
    expect(getActiveGoalMode()?.continuationCount).toBe(0)
  })

  test('completes only when the assistant emits the active goal tag', () => {
    const goal = startGoalMode('finish the task', { id: 'goal-4' })
    const wrongTag = createAssistantMessage({
      content: '<goal_complete id="old-goal" />',
    })
    const rightTag = createAssistantMessage({
      content: `Done.\n${goalCompletionTag(goal)}`,
    })

    expect(maybeCompleteGoalFromMessages([wrongTag])).toBeNull()
    expect(getActiveGoalMode()).not.toBeNull()

    const completed = maybeCompleteGoalFromMessages([wrongTag, rightTag])

    expect(completed).not.toBeNull()
    expect(completed?.reason).toBe('assistant-completion-tag')
    expect(getActiveGoalMode()).toBeNull()
  })
})
