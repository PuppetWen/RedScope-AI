import type { Command } from '../types/command.js'

const goal = {
  bridgeSafe: true,
  type: 'local-jsx',
  name: 'goal',
  description:
    'Pin a session goal and keep running until it is complete',
  argumentHint: '[status|done|cancel|objective]',
  load: () => import('./goalCommand.js'),
} satisfies Command

export default goal
