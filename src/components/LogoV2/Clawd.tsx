import * as React from 'react';
import { Box, Text } from '@anthropic/ink';

export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';

type Props = {
  pose?: ClawdPose;
};

type MarkPose = {
  top: string;
  middle: string;
  bottom: string;
};

const REDSCOPE_MARKS: Record<ClawdPose, MarkPose> = {
  default: {
    top: '  ╭───╮  ',
    middle: '╶─┤ ● ├─╴',
    bottom: '  ╰─┬─╯  ',
  },
  'look-left': {
    top: '  ╭───╮  ',
    middle: '╶─┤●  ├─╴',
    bottom: '  ╰─┬─╯  ',
  },
  'look-right': {
    top: '  ╭───╮  ',
    middle: '╶─┤  ●├─╴',
    bottom: '  ╰─┬─╯  ',
  },
  'arms-up': {
    top: '╭─┬───┬─╮',
    middle: '  │ ● │  ',
    bottom: '╶─╰─┴─╯─╴',
  },
};

export function Clawd({ pose = 'default' }: Props = {}): React.ReactNode {
  const mark = REDSCOPE_MARKS[pose];

  return (
    <Box flexDirection="column">
      <Text color="clawd_body">{mark.top}</Text>
      <Text color="clawd_body">{mark.middle}</Text>
      <Text color="clawd_body">{mark.bottom}</Text>
    </Box>
  );
}
