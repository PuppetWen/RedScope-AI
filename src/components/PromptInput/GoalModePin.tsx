import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '@anthropic/ink'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import {
  getGoalModeSnapshot,
  subscribeToGoalMode,
} from '../../utils/goalMode.js'
import { truncateToWidth } from '../../utils/format.js'

type Props = {
  isAwaitingGoalInput: boolean
}

export function GoalModePin({
  isAwaitingGoalInput,
}: Props): React.ReactNode {
  const { activeGoal } = useSyncExternalStore(
    subscribeToGoalMode,
    getGoalModeSnapshot,
  )
  const { columns } = useTerminalSize()

  if (!activeGoal && !isAwaitingGoalInput) {
    return null
  }

  const text = activeGoal
    ? activeGoal.objective
    : 'Type the goal and press Enter'
  const status = activeGoal ? 'Goal' : 'Goal pending'
  const reservedWidth = activeGoal ? 38 : 24
  const truncated = truncateToWidth(text, Math.max(12, columns - reservedWidth))

  return (
    <Box marginTop={1} paddingX={2} width="100%">
      <Box
        borderStyle="round"
        borderColor={activeGoal ? 'suggestion' : 'warning'}
        paddingX={1}
        width="100%"
        flexDirection="row"
        justifyContent="space-between"
      >
        <Box flexShrink={1}>
          <Text color={activeGoal ? 'suggestion' : 'warning'} bold>
            {status}
          </Text>
          <Text dimColor> · </Text>
          <Text wrap="truncate">{truncated}</Text>
          {activeGoal && (
            <>
              <Text dimColor> · </Text>
              <Text dimColor>runs until complete</Text>
            </>
          )}
        </Box>
        <Box
          marginLeft={1}
          flexShrink={0}
        >
          <Text dimColor>/goal cancel</Text>
        </Box>
      </Box>
    </Box>
  )
}
