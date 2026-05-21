import * as React from 'react';
import { Box, Text } from '@anthropic/ink';

type TextColor = React.ComponentProps<typeof Text>['color'];

type InfoPillProps = {
  label: string;
  color?: TextColor;
  children: React.ReactNode;
};

export function InfoPill({ label, color = 'claude', children }: InfoPillProps): React.ReactNode {
  return (
    <Text wrap="truncate">
      <Text color={color}>[</Text>
      <Text color={color} bold>
        {label}
      </Text>
      <Text dimColor>: </Text>
      <Text>{children}</Text>
      <Text color={color}>]</Text>
    </Text>
  );
}

export function InfoPillRow({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} justifyContent="center">
      {children}
    </Box>
  );
}
